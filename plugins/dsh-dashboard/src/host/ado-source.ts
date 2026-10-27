/** Azure Boards selectors are parsed locally; source URLs are never fetched. */
import { adoSourceSchema } from '../shared/requests.ts'
import type { AdoSource } from '../shared/types.ts'
import { safeSourceUrl } from '../shared/urls.ts'

const guid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const organization = /^[a-z\d](?:[a-z\d-]{0,126}[a-z\d])?$/i

export interface ParsedAdoSource {
  source: AdoSource
  sourceUrl: string
  queryId?: string
  sprint?: { path?: string; id?: string; current: boolean }
}

function equal(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/** Validate a single project or team name before using it in a URL or MCP call. */
export function selectorName(value: string, label: string): string {
  const name = value.trim()
  if (!name || /[\\/?#\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid ADO ${label}; provide a single name, not a URL or path.`)
  }
  return name
}

function scopedName(supplied: string | undefined, inferred: string | undefined, label: string): string {
  if (supplied?.trim() && inferred && !equal(supplied.trim(), inferred)) {
    throw new Error(`ADO ${label} conflicts with the source URL; correct the selectors or URL.`)
  }
  return selectorName(inferred ?? supplied ?? '', label)
}

/** Normalize a full classification path without interpreting macros or WIQL. */
export function classificationPath(value: string, project: string): string {
  const parts = value.trim().split(/[\\/]/)
  if (parts.some(part => !part.trim() || part !== part.trim() || /[\u0000-\u001f\u007f]/.test(part) || part === '.' || part === '..')) {
    throw new Error('Invalid ADO classification path; use a full Project\\Iteration or Project\\Area path.')
  }
  if (!equal(parts[0]!, project)) {
    throw new Error(`ADO path must start with project "${project}"; relative paths and iteration macros are unsupported.`)
  }
  return parts.join('\\')
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error('ADO URL contains invalid percent encoding; copy the URL again.')
  }
}

function parameters(url: URL, names: string[]): string | undefined {
  const values = names.flatMap(name => url.searchParams.getAll(name))
  if (!values.length) return undefined
  if (values.some(value => !value.trim()) || new Set(values.map(value => value.toLowerCase())).size !== 1) {
    throw new Error(`Ambiguous ADO URL parameters (${names.join(', ')}); provide one selector.`)
  }
  return values[0]
}

function samePath(left: string | undefined, right: string | undefined): string | undefined {
  if (left && right && !equal(left, right)) {
    throw new Error('ADO iteration/area paths disagree; provide one unambiguous path.')
  }
  return left ?? right
}

/** Parse supported sprint and saved-query routes, or a fully qualified classification path. */
export function parseAdoSource(input: AdoSource): ParsedAdoSource {
  const parsed = adoSourceSchema.safeParse(input)
  if (!parsed.success) throw new Error('Invalid ADO source; provide input, mode, and organization/project selectors.')
  const source = parsed.data
  const text = source.input
  const isUrl = /^[a-z][a-z\d+.-]*:/i.test(text) || text.startsWith('//')
  let orgName: string
  let project: string
  let team: string | undefined
  let sourceUrl: string
  let queryId: string | undefined
  let path: string | undefined
  let sprint: ParsedAdoSource['sprint']

  if (isUrl) {
    if (/[\\\u0000-\u0020\u007f]/.test(text)) throw new Error('Unsafe ADO URL; encode spaces and remove backslashes or control characters.')
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw new Error('Invalid ADO URL; use an HTTPS Azure Boards sprint or saved-query URL.')
    }
    const legacyHost = /^([a-z\d](?:[a-z\d-]*[a-z\d])?)\.visualstudio\.com$/i.exec(url.hostname)
    if (!safeSourceUrl(text) || url.port || (url.hostname !== 'dev.azure.com' && !legacyHost)) {
      throw new Error('Unsupported ADO URL host; use https://dev.azure.com or https://ORG.visualstudio.com.')
    }
    if (url.hash) throw new Error('ADO URL fragments are unsupported; copy a direct sprint or saved-query URL.')
    const rawPath = /^https:\/\/[^/?#]+([^?#]*)/i.exec(text)?.[1] ?? ''
    const rawParts = rawPath.split('/').slice(1)
    if (rawParts.at(-1) === '') rawParts.pop()
    const parts = rawParts.map(decodePart)
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('/') || /[\u0000-\u001f\u007f]/.test(part))) {
      throw new Error('Unsafe or ambiguous ADO URL path; remove empty, traversal, or encoded slash segments.')
    }
    const urlOrg = legacyHost ? legacyHost[1]! : parts.shift()
    if (legacyHost && parts[0]?.toLowerCase() === 'defaultcollection') parts.shift()
    orgName = scopedName(source.orgName, urlOrg, 'organization')
    project = scopedName(source.project, parts.shift(), 'project')
    let urlTeam: string | undefined
    if (parts[0] && !parts[0].startsWith('_')) urlTeam = parts.shift()
    const route = parts.shift()?.toLowerCase()
    const permitted = new Set(['_a', 'view', 'fullScreen'])
    if (route === '_queries' || route === '_workitems') {
      if (source.mode !== 'query') throw new Error('This is a saved-query URL; select query mode.')
      for (const name of ['id', 'qid', 'queryId']) permitted.add(name)
      if (route === '_workitems' && url.searchParams.get('_a') !== 'query') {
        throw new Error('A work-item list is not a saved query; provide a saved-query GUID or URL.')
      }
      if (parts[0] === 'query' || parts[0] === 'edit') parts.shift()
      const routeId = parts.shift()
      const parameterId = parameters(url, ['id', 'qid', 'queryId'])
      if (parts.length || (routeId && parameterId && !equal(routeId, parameterId))) {
        throw new Error('Ambiguous saved-query URL; provide one query GUID.')
      }
      queryId = routeId ?? parameterId
      if (!queryId || !guid.test(queryId)) throw new Error('Saved-query source requires a query GUID, not a query folder or WIQL text.')
      if (source.path) throw new Error('A saved-query source cannot also specify an iteration/area path.')
      team = source.team?.trim() || urlTeam ? scopedName(source.team, urlTeam, 'team') : undefined
    } else if (route === '_sprints') {
      if (source.mode !== 'iteration') throw new Error('This is a sprint URL; select iteration mode.')
      for (const name of ['iteration', 'iterationPath', 'iterationId']) permitted.add(name)
      if (parts[0] === 'taskboard' || parts[0] === 'backlog' || parts[0] === 'capacity') parts.shift()
      else if (parts.length) throw new Error('Unsupported sprint route; use a taskboard, backlog, or capacity sprint URL.')
      const routeTeam = parts.shift()
      if (urlTeam && routeTeam && !equal(urlTeam, routeTeam)) throw new Error('Sprint URL contains conflicting team names.')
      team = scopedName(source.team, routeTeam ?? urlTeam, 'team')
      const routeId = parts.length === 1 && guid.test(parts[0]!) ? parts[0] : undefined
      const routePath = parts.length && !routeId ? classificationPath(parts.join('\\'), project) : undefined
      const parameterPath = parameters(url, ['iteration', 'iterationPath'])
      const parameterId = parameters(url, ['iterationId'])
      let id: string | undefined = routeId
      let queryPath: string | undefined
      if (parameterPath) {
        if (guid.test(parameterPath)) {
          if (id && !equal(id, parameterPath)) throw new Error('Sprint URL contains conflicting iteration IDs.')
          id = parameterPath
        }
        else queryPath = classificationPath(parameterPath, project)
      }
      if (parameterId) {
        if (!guid.test(parameterId) || (id && !equal(id, parameterId))) throw new Error('Invalid or conflicting sprint iteration IDs; provide one GUID.')
        id = parameterId
      }
      path = samePath(routePath, queryPath)
      path = samePath(path, source.path ? classificationPath(source.path, project) : undefined)
      sprint = { ...(path ? { path } : {}), ...(id ? { id } : {}), current: !path && !id }
    } else {
      throw new Error('Unsupported ADO URL route; use a sprint URL, saved-query URL, or full iteration/area path.')
    }
    for (const key of url.searchParams.keys()) {
      if (!permitted.has(key)) throw new Error(`Unsupported ADO URL parameter "${key}"; remove filters or provide an explicit path/query GUID.`)
    }
    sourceUrl = safeSourceUrl(url.href)!
  } else {
    orgName = selectorName(source.orgName, 'organization')
    const rawPath = source.path ?? text
    const inferredProject = source.mode !== 'query' && /[\\/]/.test(rawPath) ? rawPath.split(/[\\/]/)[0] : undefined
    project = scopedName(source.project, inferredProject, 'project')
    team = source.team?.trim() ? selectorName(source.team, 'team') : undefined
    if (source.mode === 'query') {
      if (!guid.test(text) || source.path) throw new Error('Saved-query source requires a GUID or supported saved-query URL, without a classification path.')
      queryId = text
    } else {
      path = classificationPath(text, project)
      path = samePath(path, source.path ? classificationPath(source.path, project) : undefined)
      if (source.mode === 'iteration' && team) sprint = { path, current: false }
    }
    sourceUrl = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(project)}/${queryId ? `_queries/query/${queryId}` : '_workitems'}`
  }
  if (!organization.test(orgName)) throw new Error('Invalid ADO organization; provide the organization name, not its URL.')
  if (source.mode === 'area' && team) {
    throw new Error('Team-scoped area reads require all team area-membership rules, which this provider cannot establish. Remove team for a project-wide area scope, or use a team sprint URL.')
  }
  if (sprint && source.includeChildren) {
    throw new Error('Team-scoped sprints select one exact iteration. Disable includeChildren, or use an explicit project-wide iteration path without team.')
  }
  const normalized: AdoSource = { ...source, orgName, project, ...(team ? { team } : {}), ...(path ? { path } : {}) }
  return { source: normalized, sourceUrl, ...(queryId ? { queryId } : {}), ...(sprint ? { sprint } : {}) }
}

/** Escape data inside a WIQL single-quoted string literal. */
export function wiqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Produce an ID-ordered, project-scoped query; user input is never treated as WIQL. */
export function scopeWiql(source: AdoSource, afterId: number): string {
  if (source.mode === 'query' || !source.path) throw new Error('WIQL scope requires an explicit iteration or area path.')
  if (source.team?.trim()) throw new Error('Project-wide WIQL cannot establish team area membership; use the team iteration endpoint.')
  if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('Invalid ADO ID pagination cursor.')
  const field = source.mode === 'area' ? 'System.AreaPath' : 'System.IterationPath'
  return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${wiqlLiteral(source.project)} AND [${field}] ${source.includeChildren ? 'UNDER' : '='} ${wiqlLiteral(source.path)} AND [System.Id] > ${afterId} ORDER BY [System.Id] ASC`
}
