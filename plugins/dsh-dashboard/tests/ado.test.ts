import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAdo } from '../src/host/ado.ts'
import { parseAdoSource, scopeWiql } from '../src/host/ado-source.ts'
import type { AdoOptions, AdoSource, ReadOnlyMcp } from '../src/shared/types.ts'

const now = '2026-09-12T12:00:00.000Z'
const sprintId = '12345678-1234-4123-8123-123456789012'
const queryId = '87654321-4321-4321-8321-210987654321'
const baseSource: AdoSource = { input: 'Project\\Release\\Sprint 1', orgName: 'sample-org', project: 'Project', mode: 'iteration' }
const baseOptions: AdoOptions = { maxItems: 100, pageSize: 25, staleDays: 7, blockedTags: ['Blocked'], now: () => new Date(now) }
const standardStates = [
  { name: 'New', category: 'Proposed' },
  { name: 'Doing', category: 'InProgress' },
  { name: 'Verified', category: 'Resolved' },
  { name: 'Delivered to orbit', category: 'Completed' },
  { name: 'Not pursuing', category: 'Removed' },
]

type RecordItem = { id: number; fields: Record<string, unknown> }
type Call = { operation: string; args: Record<string, unknown>; signal: AbortSignal }
type Handler = (call: Call) => unknown | Promise<unknown>

function record(id: number, fields: Record<string, unknown> = {}): RecordItem {
  return {
    id,
    fields: {
      'System.Title': `Work item ${id}`, 'System.TeamProject': 'Project', 'System.WorkItemType': 'User Story',
      'System.State': 'Doing', 'System.AreaPath': 'Project\\Area', 'System.IterationPath': 'Project\\Release\\Sprint 1',
      'System.AssignedTo': { id: 'person-1', displayName: 'Test Person', uniqueName: 'test@example.invalid' },
      'System.ChangedDate': '2026-09-11T12:00:00Z',
      ...fields,
    },
  }
}

/** Each fixture verifies the logical read-only operation and its real MCP parameter names. */
function fakeMcp(records: RecordItem[] = [], override?: (call: Call) => { result: unknown } | undefined): { mcp: ReadOnlyMcp; calls: Call[] } {
  const calls: Call[] = []
  const handler: Handler = async call => {
    const { operation, args } = call
    assert.equal(typeof args.orgName, 'string')
    assert.ok(args.orgName)
    assert.equal(typeof args.project, 'string')
    assert.ok(args.project)
    assert.ok(
      (operation === 'wit_query' && ['wiql', 'get_results'].includes(String(args.action)))
      || (operation === 'wit_work_item' && ['get_batch', 'get_type', 'list_for_iteration'].includes(String(args.action)))
      || (operation === 'work' && args.action === 'list_team_iterations'),
      `Unexpected operation ${operation}/${String(args.action)}`,
    )
    if (args.action === 'wiql') {
      assert.equal(typeof args.wiql, 'string')
      assert.ok(Number.isInteger(args.top) && Number(args.top) > 0 && Number(args.top) <= 1000)
      assert.equal(args.query, undefined)
      assert.match(String(args.wiql), /ORDER BY \[System\.Id\] ASC$/)
    }
    if (args.action === 'get_batch') {
      assert.ok(Array.isArray(args.ids) && args.ids.length > 0 && args.ids.length <= 200)
      assert.equal(args.expand, 'Relations')
      assert.equal(args.fields, undefined)
    }
    if (args.action === 'get_type') assert.equal(typeof args.workItemType, 'string')
    if (args.action === 'list_for_iteration') {
      assert.ok(args.team)
      assert.equal(typeof args.iterationId, 'string')
      assert.equal(args.top, undefined)
    }
    if (args.action === 'list_team_iterations') {
      assert.ok(args.team)
      assert.ok(args.timeframe === undefined || args.timeframe === 'current')
    }
    const overridden = override?.(call)
    if (overridden) return overridden.result
    if (args.action === 'wiql') {
      const cursor = Number(/\[System\.Id\] > (\d+)/.exec(String(args.wiql))![1])
      return { queryType: 'flat', workItems: records.filter(item => item.id > cursor).sort((a, b) => a.id - b.id).slice(0, Number(args.top)).map(({ id }) => ({ id })) }
    }
    if (args.action === 'get_results') return { queryType: 1, workItems: records.slice(0, Number(args.top)).map(({ id }) => ({ id })) }
    if (args.action === 'list_for_iteration') return { workItemRelations: records.map(({ id }) => ({ rel: null, source: null, target: { id } })) }
    if (args.action === 'list_team_iterations') return [{ id: sprintId, name: 'Sprint 1', path: baseSource.input }]
    if (args.action === 'get_batch') return { count: records.filter(item => (args.ids as number[]).includes(item.id)).length, value: records.filter(item => (args.ids as number[]).includes(item.id)).reverse() }
    if (args.action === 'get_type') return { name: args.workItemType, states: standardStates }
    throw new Error(`No fixture for ${operation}/${String(args.action)}`)
  }
  return {
    calls,
    mcp: {
      async call(operation, args, signal) {
        const call = { operation, args, signal }
        calls.push(call)
        return handler(call)
      },
    },
  }
}

async function load(records: RecordItem[], override?: Parameters<typeof fakeMcp>[1], options: Partial<AdoOptions> = {}, source: AdoSource = baseSource) {
  const fixture = fakeMcp(records, override)
  const signal = new AbortController().signal
  const snapshot = await loadAdo(fixture.mcp, source, { ...baseOptions, ...options }, signal)
  assert.ok(fixture.calls.every(call => call.signal === signal))
  return { ...fixture, snapshot }
}

test('parses modern and legacy sprint URLs, including encoded names and quoted paths', () => {
  for (const input of [
    "https://dev.azure.com/sample-org/Project/_sprints/taskboard/My%20Team/Project/Release/Sprint%20O%27Brien",
    "https://sample-org.visualstudio.com/Project/_sprints/backlog/My%20Team/Project/Release/Sprint%20O%27Brien",
    "https://sample-org.visualstudio.com/DefaultCollection/Project/_sprints/capacity/My%20Team/Project/Release/Sprint%20O%27Brien",
    "https://dev.azure.com/sample-org/Project/My%20Team/_sprints/taskboard/My%20Team/Project/Release/Sprint%20O%27Brien",
  ]) {
    const parsed = parseAdoSource({ ...baseSource, input, orgName: '', project: '' })
    assert.equal(parsed.source.orgName, 'sample-org')
    assert.equal(parsed.source.project, 'Project')
    assert.equal(parsed.source.team, 'My Team')
    assert.equal(parsed.source.path, "Project\\Release\\Sprint O'Brien")
    assert.deepEqual(parsed.sprint, { path: "Project\\Release\\Sprint O'Brien", current: false })
  }
})

test('parses iteration IDs and saved-query GUID routes without fetching their URLs', () => {
  const prefix = 'https://dev.azure.com/sample-org/Project'
  for (const input of [
    `${prefix}/_queries/query/${queryId}`,
    `${prefix}/_queries/edit/${queryId}`,
    `${prefix}/_queries?queryId=${queryId}`,
    `${prefix}/_workitems?_a=query&qid=${queryId}`,
    `https://sample-org.visualstudio.com/Project/_queries/query/${queryId}`,
    queryId,
  ]) assert.equal(parseAdoSource({ ...baseSource, mode: 'query', input }).queryId, queryId)
  for (const input of [
    `${prefix}/_sprints/taskboard/Team?iterationId=${sprintId}`,
    `${prefix}/_sprints/taskboard/Team?iteration=${sprintId}`,
    `${prefix}/_sprints/taskboard/Team/${sprintId}`,
  ]) assert.deepEqual(parseAdoSource({ ...baseSource, input }).sprint, { id: sprintId, current: false })
})

test('full area and iteration paths infer project, preserve quotes, and escape WIQL values', () => {
  const parsed = parseAdoSource({
    input: "O'Brien Project/Area/Manager's scope", project: '', orgName: 'sample-org', mode: 'area', includeChildren: true,
  })
  assert.equal(parsed.source.project, "O'Brien Project")
  assert.equal(parsed.source.path, "O'Brien Project\\Area\\Manager's scope")
  assert.equal(scopeWiql(parsed.source, 42), "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'O''Brien Project' AND [System.AreaPath] UNDER 'O''Brien Project\\Area\\Manager''s scope' AND [System.Id] > 42 ORDER BY [System.Id] ASC")
  assert.match(scopeWiql(parseAdoSource(baseSource).source, 0), /\[System\.IterationPath\] = 'Project\\Release\\Sprint 1'/)
  assert.match(scopeWiql({ ...parsed.source, includeChildren: false }, 0), /\[System\.AreaPath\] = /)
  assert.match(scopeWiql({ ...parseAdoSource(baseSource).source, includeChildren: true }, 0), /\[System\.IterationPath\] UNDER /)
  assert.throws(() => scopeWiql(parsed.source, -1), /cursor/)
  assert.throws(() => scopeWiql({ ...parsed.source, team: 'Team' }, 0), /team area membership/)
})

test('rejects unsafe hosts, URLs, ambiguous selectors, and unresolved names', () => {
  const invalid: [Partial<AdoSource>, RegExp][] = [
    [{ input: 'https://attacker.invalid/Project/_sprints/taskboard/Team' }, /host/],
    [{ input: 'https://dev.azure.com.attacker.invalid/sample-org/Project/_queries/query/x' }, /host/],
    [{ input: 'https://sample-org.attacker.visualstudio.com/Project/_sprints' }, /host/],
    [{ input: 'https://user:secret@dev.azure.com/sample-org/Project/_sprints' }, /host/],
    [{ input: 'http://dev.azure.com/sample-org/Project/_sprints' }, /host/],
    [{ input: 'https://dev.azure.com:8443/sample-org/Project/_sprints' }, /host/],
    [{ input: 'file:///C:/local' }, /host/],
    [{ input: 'javascript:alert(1)' }, /host/],
    [{ input: 'https://dev.azure.com/sample-org/Project/../Project/_sprints' }, /traversal/],
    [{ input: 'https://dev.azure.com/sample-org/Project/%2e%2e/Project/_sprints' }, /traversal/],
    [{ input: 'https://dev.azure.com/sample-org/Pro%2fject/_sprints' }, /encoded slash/],
    [{ input: 'https://dev.azure.com/sample-org/Pro%GGject/_sprints' }, /encoding/],
    [{ input: 'https://dev.azure.com/sample-org/Project/_sprints#wrong-sprint' }, /fragments/],
    [{ input: 'https://dev.azure.com/sample-org/Project/_sprints/taskboard/My Team' }, /encode spaces/],
    [{ input: 'https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team', team: 'Other' }, /team conflicts/],
    [{ input: 'https://dev.azure.com/another-org/Project/_sprints/taskboard/Team' }, /organization conflicts/],
    [{ input: 'https://dev.azure.com/sample-org/Other/_sprints/taskboard/Team' }, /project conflicts/],
    [{ input: 'https://dev.azure.com/sample-org/Project/_sprints' }, /team/],
    [{ orgName: '' }, /organization/],
    [{ input: 'Sprint 1', project: '' }, /project/],
    [{ input: 'Other\\Sprint' }, /project conflicts/],
    [{ input: 'Project\\..\\Sprint' }, /classification path/],
    [{ input: 'Project\\Sprint', path: 'Project\\Other' }, /disagree/],
    [{ input: 'Project\\Area', team: 'Team', mode: 'area' }, /area-membership rules/],
    [{ team: 'Team', includeChildren: true }, /one exact iteration/],
    [{ input: 'https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team', includeChildren: true }, /one exact iteration/],
    [{ input: `https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team?iterationId=${sprintId}&iterationId=${queryId}` }, /Ambiguous/],
    [{ input: 'https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team?iteration=ShortName' }, /path must start/],
    [{ input: 'https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team?filter=Mine' }, /Unsupported.*parameter/],
    [{ input: `https://dev.azure.com/sample-org/Project/_queries/query/${queryId}` }, /select query mode/],
    [{ input: 'Shared Queries\\Delivery', mode: 'query' }, /GUID/],
    [{ input: queryId, project: '', mode: 'query' }, /project/],
    [{ input: queryId, mode: 'query', path: 'Project\\Sprint' }, /classification path/],
    [{ input: `https://dev.azure.com/sample-org/Project/_queries/query/${queryId}?queryId=${sprintId}`, mode: 'query' }, /Ambiguous/],
    [{ input: 'https://dev.azure.com/sample-org/Project/_queries', mode: 'query' }, /GUID/],
  ]
  for (const [source, expected] of invalid) assert.throws(() => parseAdoSource({ ...baseSource, ...source }), expected, JSON.stringify(source))
})

test('sprint resolution matches the exact full path, never an unrelated sprint with the same name', async () => {
  const source = { ...baseSource, input: 'https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team/Project/Release/Sprint%201' }
  const { snapshot, calls } = await load([record(1)], call => call.args.action === 'list_team_iterations' ? {
    result: { count: 2, value: [
      { id: queryId, name: 'Sprint 1', path: 'Project\\Other\\Sprint 1' },
      { id: sprintId, name: 'Sprint 1', path: baseSource.input, attributes: { startDate: '2026-09-01T00:00:00Z', finishDate: '2026-09-15T00:00:00Z' } },
    ] },
  } : undefined, {}, source)
  assert.equal(snapshot.iteration?.id, sprintId)
  assert.equal(snapshot.iteration?.start, '2026-09-01T00:00:00.000Z')
  assert.equal(snapshot.source.path, baseSource.input)
  assert.equal(calls[0]?.args.timeframe, undefined)
  assert.equal(calls[1]?.args.action, 'list_for_iteration')
  assert.equal(calls[1]?.args.iterationId, sprintId)
  assert.equal(calls.some(call => call.operation === 'wit_query'), false)
})

test('a legacy June URL uses the exact path and dates despite a misleading Current timeFrame', async () => {
  const project = 'Delivery Engineering'
  const path = `${project}\\CY26\\CY26-H1-Xe\\CY26-06 (Jun)`
  const source: AdoSource = {
    input: 'https://sample-org.visualstudio.com/Delivery%20Engineering/_sprints/taskboard/Compliance%20Automation/Delivery%20Engineering/CY26/CY26-H1-Xe/CY26-06%20(Jun)',
    orgName: 'sample-org', project, team: 'Compliance Automation', path, mode: 'iteration',
  }
  assert.deepEqual(parseAdoSource(source).sprint, { path, current: false })
  const { snapshot, calls } = await load([
    record(1, { 'System.TeamProject': project, 'System.IterationPath': path, 'System.AreaPath': `${project}\\Delivery` }),
  ], call => call.args.action === 'list_team_iterations' ? {
    result: [
      { id: queryId, name: 'CY26-09 (Sep)', path: `${project}\\CY26\\CY26-H2-Xe\\CY26-09 (Sep)`, attributes: { startDate: '2026-09-01T00:00:00Z', finishDate: '2026-09-30T00:00:00Z' } },
      { id: sprintId, name: 'CY26-06 (Jun)', path, attributes: { startDate: '2026-06-01T00:00:00Z', finishDate: '2026-06-30T00:00:00Z', timeFrame: 'Current' } },
    ],
  } : undefined, {}, source)
  assert.equal(snapshot.iteration?.id, sprintId)
  assert.equal(snapshot.iteration?.path, path)
  assert.equal(snapshot.iteration?.finish, '2026-06-30T00:00:00.000Z')
  assert.equal(snapshot.generatedAt, now)
  assert.equal(snapshot.source.path, path)
  assert.equal(calls[0]?.args.team, 'Compliance Automation')
  assert.equal(Object.hasOwn(calls[0]!.args, 'timeframe'), false)
  assert.equal(calls[1]?.args.action, 'list_for_iteration')
  assert.equal(calls[1]?.args.iterationId, sprintId)
  assert.equal(calls.some(call => call.operation === 'wit_query'), false)
  assert.equal(snapshot.items[0]?.iterationPath, path)
})

test('sprint IDs, current sprint, and an explicit path override resolve without choosing by list order', async () => {
  for (const source of [
    { ...baseSource, input: `https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team?iterationId=${sprintId}` },
    { ...baseSource, input: 'https://dev.azure.com/sample-org/Project/_sprints', team: 'Team' },
    { ...baseSource, input: 'https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team', path: baseSource.input },
  ]) {
    const { snapshot, calls } = await load([], call => call.args.action === 'list_team_iterations' ? {
      result: [{ id: sprintId, name: 'Sprint 1', path: baseSource.input }],
    } : undefined, {}, source)
    assert.equal(snapshot.iteration?.id, sprintId)
    assert.equal(calls[0]?.args.timeframe, source.input.endsWith('_sprints') ? 'current' : undefined)
  }
})

test('missing, duplicate, conflicting, truncated, or invalid sprint results fail before querying work items', async () => {
  const source = { ...baseSource, input: `https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team/Project/Release/Sprint%201?iterationId=${sprintId}` }
  for (const result of [
    [],
    [{ id: sprintId, name: 'Other', path: 'Project\\Other' }],
    [{ id: queryId, name: 'Sprint 1', path: baseSource.input }],
    [1],
    { unexpected: [] },
    { value: [{ id: sprintId, name: 'Sprint 1', path: baseSource.input }], continuationToken: 'more' },
    [
      { id: sprintId, name: 'Sprint 1', path: baseSource.input },
      { id: sprintId, name: 'Sprint 1', path: baseSource.input },
    ],
  ]) {
    const fixture = fakeMcp([], () => ({ result }))
    await assert.rejects(loadAdo(fixture.mcp, source, baseOptions, new AbortController().signal), /sprint|iteration/i)
    assert.equal(fixture.calls.length, 1)
  }
})

test('team iteration membership excludes another team sharing the iteration and filters parent context', async () => {
  const rows = [
    record(1, { 'System.AreaPath': 'Project\\Team A' }),
    record(2, { 'System.AreaPath': 'Project\\Team B' }),
    record(3, { 'System.AreaPath': 'Project\\Team A', 'System.WorkItemType': 'Task' }),
    record(4, { 'System.AreaPath': 'Project\\Team A', 'System.WorkItemType': 'Epic', 'System.IterationPath': 'Project' }),
  ]
  const source: AdoSource = {
    ...baseSource, input: 'https://dev.azure.com/sample-org/Project/_sprints/taskboard/Team%20A/Project/Release/Sprint%201',
  }
  const { snapshot, calls } = await load(rows, call => call.args.action === 'list_for_iteration' ? {
    result: { workItemRelations: [
      { rel: null, source: null, target: { id: 4 } },
      { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 4 }, target: { id: 1 } },
      { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 1 }, target: { id: 3 } },
      { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 1 }, target: { id: 3 } },
    ] },
  } : undefined, {}, source)
  assert.deepEqual(snapshot.items.map(item => item.id), [1, 3])
  assert.equal(snapshot.complete, true)
  assert.equal(snapshot.defaultType, 'User Story')
  assert.equal(calls[1]?.args.team, 'Team A')
  assert.equal(calls[1]?.args.iterationId, sprintId)
  assert.deepEqual(calls.find(call => call.args.action === 'get_batch')?.args.ids, [1, 3, 4])
  assert.equal(calls.some(call => call.operation === 'wit_query'), false)
  assert.ok(snapshot.warnings.some(warning => /1 contextual work items outside/.test(warning)))
  assert.equal(calls.some(call => call.args.workItemType === 'Epic'), false)
})

test('source-only parents do not become team members even when they share the selected iteration', async () => {
  const { snapshot, calls } = await load([
    record(1, { 'System.AreaPath': 'Project\\Team A' }),
    record(2, { 'System.AreaPath': 'Project\\Team B', 'System.WorkItemType': 'Epic' }),
  ], call => call.args.action === 'list_for_iteration' ? {
    result: { workItemRelations: [
      { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 2 }, target: { id: 1 } },
    ] },
  } : undefined, {}, { ...baseSource, team: 'Team A' })
  assert.deepEqual(snapshot.items.map(item => item.id), [1])
  assert.deepEqual(calls.find(call => call.args.action === 'get_batch')?.args.ids, [1])
  assert.equal(snapshot.complete, false)
  assert.ok(snapshot.warnings.some(warning => /source-only parent references/.test(warning)))
  assert.equal(calls.some(call => call.operation === 'wit_query'), false)
})

test('team membership honors caps, missing hydration, empty results, and explicit truncation', async () => {
  const source = { ...baseSource, team: 'Team' }
  const capped = await load([record(1), record(2), record(3)], undefined, { maxItems: 2 }, source)
  assert.deepEqual(capped.snapshot.items.map(item => item.id), [1, 2])
  assert.equal(capped.snapshot.complete, false)
  assert.ok(capped.snapshot.warnings.some(warning => /Team iteration work-item cap/.test(warning)))
  const missing = await load([record(1)], call => call.args.action === 'list_for_iteration' ? {
    result: { workItemRelations: [{ target: { id: 1 } }, { target: { id: 2 } }] },
  } : undefined, {}, source)
  assert.equal(missing.snapshot.complete, false)
  assert.ok(missing.snapshot.warnings.some(warning => /Missing IDs: 2/.test(warning)))
  const empty = await load([], undefined, {}, source)
  assert.equal(empty.snapshot.complete, true)
  assert.deepEqual(empty.snapshot.items, [])
  assert.equal(empty.calls.length, 2)
  const truncated = await load([], call => call.args.action === 'list_for_iteration' ? {
    result: { workItemRelations: [], continuationToken: 'more' },
  } : undefined, {}, source)
  assert.equal(truncated.snapshot.complete, false)
  assert.ok(truncated.snapshot.warnings.some(warning => /membership is truncated/.test(warning)))
})

test('unsupported team relation JSON fails rather than substituting project-wide WIQL', async () => {
  for (const result of [
    {}, { workItems: [] }, { workItemRelations: null }, { workItemRelations: [{ target: null }] },
    { workItemRelations: [{ target: { id: '1' } }] },
    { workItemRelations: [{ rel: 'System.LinkTypes.Related', source: { id: 1 }, target: { id: 2 } }] },
    { workItemRelations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', source: { id: 1 }, target: { id: 2 } }] },
    { workItemRelations: [{ source: { id: 1 }, target: { id: 2 } }] },
  ]) {
    await assert.rejects(load([], call => call.args.action === 'list_for_iteration' ? { result } : undefined, {}, { ...baseSource, team: 'Team' }), /Unsupported ADO/)
  }
})

test('uses custom state categories, not state names, for completion, removal, and risks', async () => {
  const riskFields = {
    'System.AssignedTo': null, 'System.Tags': 'Blocked; another', 'System.ChangedDate': '2026-09-01T12:00:00Z',
    'Microsoft.VSTS.Scheduling.DueDate': '2026-09-10T12:00:00Z',
  }
  const rows = [
    record(1, { ...riskFields, 'System.State': 'Delivered to orbit' }),
    record(2, { ...riskFields, 'System.State': 'Not pursuing' }),
    record(3, { ...riskFields, 'System.State': 'Closed' }),
    record(4, { ...riskFields, 'System.State': 'Verified' }),
    record(5, { ...riskFields, 'System.State': 'New' }),
    record(6, { ...riskFields, 'System.State': 'Future' }),
  ]
  const { snapshot } = await load(rows, call => call.args.action === 'get_type' ? {
    result: { name: call.args.workItemType, states: [...standardStates, { name: 'Future', category: 'AnUnrecognizedCategory' }] },
  } : undefined)
  assert.deepEqual(snapshot.items.map(item => item.category), ['Completed', 'Removed', 'Unknown', 'Resolved', 'Proposed', 'Unknown'])
  assert.deepEqual(snapshot.items.slice(0, 3).map(item => item.risks), [[], [], []])
  assert.deepEqual(snapshot.items[3]?.risks, ['unassigned', 'blocked', 'stale', 'overdue'])
  assert.deepEqual(snapshot.items[4]?.risks, ['unassigned', 'blocked', 'stale', 'overdue'])
  assert.deepEqual(snapshot.items[5]?.risks, [])
  assert.ok(snapshot.warnings.some(warning => warning.includes('Unknown state mapping') && warning.includes('Closed')))
  assert.ok(snapshot.warnings.some(warning => warning.includes('Unknown state category')))
  assert.ok(snapshot.warnings.some(warning => warning.startsWith('No update')))
})

test('unavailable or absent per-state categories stay Unknown with explicit warnings', async () => {
  for (const metadata of [
    { name: 'User Story' }, { name: 'User Story', states: [] },
    { name: 'User Story', states: [{ name: 'Doing' }] },
    { name: 'User Story', states: [{ name: 'Doing', category: null }] },
  ]) {
    const { snapshot } = await load([record(1, { 'System.AssignedTo': undefined })], call => call.args.action === 'get_type' ? { result: metadata } : undefined)
    assert.equal(snapshot.items[0]?.category, 'Unknown')
    assert.deepEqual(snapshot.items[0]?.risks, [])
    assert.ok(snapshot.warnings.some(warning => /Unknown/.test(warning)))
  }
})

test('pages with ID keysets, bounded page sizes, and sorted hydration despite reversed batches', async () => {
  const { snapshot, calls } = await load([1, 7, 13, 21, 30].map(id => record(id)), undefined, { pageSize: 2 })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.items.map(item => item.id), [1, 7, 13, 21, 30])
  assert.deepEqual(calls.filter(call => call.args.action === 'wiql').map(call => /\[System.Id\] > (\d+)/.exec(String(call.args.wiql))?.[1]), ['0', '7', '21'])
  assert.equal(calls.filter(call => call.args.action === 'get_type').length, 1)
  assert.equal(snapshot.generatedAt, now)
})

test('WIQL is capped at 1000 and hydration batches at 200, including an exact final page', async () => {
  const { snapshot, calls } = await load(Array.from({ length: 1001 }, (_, index) => record(index + 1)), undefined, { maxItems: 1100, pageSize: 5000 })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(calls.filter(call => call.args.action === 'wiql').map(call => call.args.top), [1000, 100])
  assert.deepEqual(calls.filter(call => call.args.action === 'get_batch').map(call => (call.args.ids as number[]).length), [200, 200, 200, 200, 200, 1])
  const exact = await load([record(1), record(2)], undefined, { pageSize: 2 })
  assert.equal(exact.snapshot.complete, true)
  assert.equal(exact.calls.filter(call => call.args.action === 'wiql').length, 2)
})

test('hitting maxItems is explicitly partial even when the fixture contains exactly that many', async () => {
  const { snapshot, calls } = await load([1, 2, 3].map(id => record(id)), undefined, { maxItems: 3, pageSize: 2 })
  assert.equal(snapshot.complete, false)
  assert.deepEqual(calls.filter(call => call.args.action === 'wiql').map(call => call.args.top), [2, 1])
  assert.ok(snapshot.warnings.some(warning => warning.includes('cap (3)')))
})

test('empty flat results are complete and do not request hydration or invent a delivery type', async () => {
  const { snapshot, calls } = await load([])
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.items, [])
  assert.equal(snapshot.defaultType, '')
  assert.equal(calls.length, 1)
})

test('missing hydration IDs and explicit provider truncation make results partial', async () => {
  const missing = await load([record(1), record(2), record(3)], call => call.args.action === 'get_batch' ? { result: [record(1), record(3)] } : undefined)
  assert.equal(missing.snapshot.complete, false)
  assert.deepEqual(missing.snapshot.items.map(item => item.id), [1, 3])
  assert.ok(missing.snapshot.warnings.some(warning => /Missing IDs: 2/.test(warning)))
  const truncated = await load([record(1)], call => call.args.action === 'wiql' ? { result: { workItems: [{ id: 1 }], isTruncated: true } } : undefined)
  assert.equal(truncated.snapshot.complete, false)
  assert.ok(truncated.snapshot.warnings.some(warning => /page incomplete/.test(warning)))
  const batch = await load([record(1)], call => call.args.action === 'get_batch' ? { result: { value: [record(1)], hasMore: true } } : undefined)
  assert.equal(batch.snapshot.complete, false)
  assert.ok(batch.snapshot.warnings.some(warning => /hydration reported truncation/.test(warning)))
})

test('saved queries call get_results with the GUID and never rewrite or page arbitrary WIQL', async () => {
  const source = { ...baseSource, input: queryId, mode: 'query' as const, team: 'Team' }
  const first = await load([record(1), record(2)], undefined, {}, source)
  assert.equal(first.snapshot.complete, true)
  assert.equal(first.calls[0]?.args.id, queryId)
  assert.equal(first.calls[0]?.args.team, 'Team')
  assert.equal(first.calls[0]?.args.top, baseOptions.maxItems)
  assert.equal(first.calls[0]?.args.action, 'get_results')
  assert.equal(first.calls.some(call => call.args.action === 'wiql'), false)
  assert.equal(first.snapshot.sourceUrl, `https://dev.azure.com/sample-org/Project/_queries/query/${queryId}`)
  const capped = await load([record(1), record(2)], undefined, { maxItems: 2 }, source)
  assert.equal(capped.snapshot.complete, false)
  assert.ok(capped.snapshot.warnings.some(warning => /no continuation/.test(warning)))
  const token = await load([record(1)], call => call.args.action === 'get_results' ? { result: { workItems: [{ id: 1 }], continuationToken: 'more' } } : undefined, {}, source)
  assert.equal(token.snapshot.complete, false)
  const upperLimit = await load([], undefined, { maxItems: 2000 }, source)
  assert.equal(upperLimit.calls[0]?.args.top, 1000)
})

test('mixed types retain separate estimates, preserve missing values, and default one delivery type', async () => {
  const { snapshot } = await load([
    record(1, { 'System.WorkItemType': 'Epic', 'Microsoft.VSTS.Scheduling.Effort': 100 }),
    record(2, { 'System.WorkItemType': 'Task', 'Microsoft.VSTS.Scheduling.RemainingWork': 8 }),
    record(3, { 'System.WorkItemType': 'Product Backlog Item', 'Microsoft.VSTS.Scheduling.Effort': 5 }),
    record(4, { 'System.WorkItemType': 'Requirement', 'Microsoft.VSTS.Scheduling.Size': 13 }),
    record(5, { 'Microsoft.VSTS.Scheduling.StoryPoints': 0 }),
    record(6),
    record(7, { 'System.WorkItemType': 'Bug', 'Microsoft.VSTS.Scheduling.StoryPoints': 3 }),
    record(8, { 'System.WorkItemType': 'Product Backlog Item', 'Microsoft.VSTS.Scheduling.Effort': 8, 'Microsoft.VSTS.Scheduling.StoryPoints': 2 }),
  ])
  assert.equal(snapshot.defaultType, 'User Story')
  assert.equal(snapshot.items.length, 8)
  assert.equal(snapshot.items[1]?.estimate, undefined)
  assert.equal(snapshot.items[1]?.estimateField, undefined)
  assert.equal(snapshot.items[1]?.remainingWork, 8)
  assert.equal(snapshot.items[2]?.estimate, 5)
  assert.equal(snapshot.items[2]?.estimateField, 'Microsoft.VSTS.Scheduling.Effort')
  assert.equal(snapshot.items[3]?.estimateField, 'Microsoft.VSTS.Scheduling.Size')
  assert.equal(snapshot.items[4]?.estimate, 0)
  assert.equal(Object.hasOwn(snapshot.items[5]!, 'estimate'), false)
  assert.equal(snapshot.items[7]?.estimate, 8)
  assert.ok(snapshot.warnings.some(warning => /not aggregated/.test(warning)))
  assert.ok(snapshot.warnings.some(warning => /must not be summed/.test(warning)))
  assert.ok(snapshot.warnings.some(warning => /multiple estimate fields/.test(warning)))
  for (const [types, expected] of [
    [['Epic', 'Task', 'Bug', 'Product Backlog Item'], 'Product Backlog Item'],
    [['Task', 'Requirement'], 'Requirement'],
    [['Task', 'Bug'], 'Task'],
    [['Bug'], 'Bug'],
    [['Investigation'], 'Investigation'],
  ] as [string[], string][]) {
    const selected = await load(types.map((type, index) => record(index + 1, { 'System.WorkItemType': type })))
    assert.equal(selected.snapshot.defaultType, expected)
  }
})

test('each project and type uses its own state metadata and canonical work-item URL', async () => {
  const { snapshot, calls } = await load([
    record(1),
    record(2, { 'System.TeamProject': "O'Brien Project" }),
  ], call => call.args.action === 'get_type' && call.args.project === "O'Brien Project" ? {
    result: { name: 'User Story', states: [{ name: 'Doing', category: 'Completed' }] },
  } : undefined, {}, { ...baseSource, input: queryId, mode: 'query' })
  assert.equal(snapshot.items[0]?.category, 'InProgress')
  assert.equal(snapshot.items[1]?.category, 'Completed')
  assert.equal(snapshot.items[1]?.url, "https://dev.azure.com/sample-org/O'Brien%20Project/_workitems/edit/2")
  assert.deepEqual(calls.filter(call => call.args.action === 'get_type').map(call => call.args.project), ['Project', "O'Brien Project"])
})

test('risk flags use explicit blocked data, ChangedDate, and due fields, not iteration finish or RemainingWork', async () => {
  const rows = [
    record(1, { 'System.Tags': ' NOT BLOCKED ; stalled ', 'System.ChangedDate': '2026-09-05T12:00:00Z', 'Microsoft.VSTS.Scheduling.DueDate': '2026-09-12' }),
    record(2, { 'System.Tags': 'blockedish', 'Microsoft.VSTS.Scheduling.FinishDate': '2020-01-01', 'Microsoft.VSTS.Scheduling.RemainingWork': 500 }),
    record(3, { 'Microsoft.VSTS.CMMI.Blocked': 'Yes', 'Custom.DueDate': '2026-09-11' }),
    record(4, { 'Custom.Blocked': true, 'System.AssignedTo': 'Test User <test@example.invalid>' }),
    record(5, { 'Microsoft.VSTS.Common.Blocked': 'No', 'System.ChangedDate': '2026-09-05T12:00:00.001Z' }),
    record(6, { 'Microsoft.VSTS.Scheduling.DueDate': now, 'System.ChangedDate': '2027-01-01T00:00:00Z' }),
    record(7, { 'System.AssignedTo': { uniqueName: 'test@example.invalid' }, 'Custom.Blocked': 'unknown' }),
  ]
  const { snapshot } = await load(rows, undefined, { blockedTags: ['STALLED'] })
  assert.deepEqual(snapshot.items.map(item => item.risks), [
    ['blocked', 'stale'], [], ['blocked', 'overdue'], ['blocked'], [], [], [],
  ])
  const zero = await load([record(1, { 'Microsoft.VSTS.Scheduling.RemainingWork': 0 })])
  assert.equal(zero.snapshot.items[0]?.remainingWork, 0)
  assert.equal(zero.snapshot.items[0]?.estimate, undefined)
})

test('invalid optional dates and estimates are warned about, never silently zeroed or overdue', async () => {
  const { snapshot } = await load([record(1, {
    'System.ChangedDate': 'not-a-date', 'Microsoft.VSTS.Scheduling.DueDate': '2026',
    'Microsoft.VSTS.Scheduling.StoryPoints': '5', 'Microsoft.VSTS.Scheduling.Effort': -2,
    'Microsoft.VSTS.Scheduling.RemainingWork': {}, 'Microsoft.VSTS.Common.Priority': Infinity,
  })])
  assert.equal(snapshot.items[0]?.estimate, undefined)
  assert.equal(snapshot.items[0]?.changedAt, undefined)
  assert.equal(snapshot.items[0]?.dueDate, undefined)
  assert.deepEqual(snapshot.items[0]?.risks, [])
  assert.ok(snapshot.warnings.some(warning => /not treated as zero/.test(warning)))
  assert.ok(snapshot.warnings.some(warning => /invalid ISO date/.test(warning)))
})

test('invalid query JSON, unsupported tree queries, broken ordering, and false empty envelopes fail explicitly', async () => {
  for (const result of [
    null, '[]', {}, { content: [{ type: 'text', text: '[]' }] }, { error: 'denied' },
    { workItems: '[]' }, { value: [], workItems: [] }, { workItems: [{ id: '1' }] },
    { workItems: [{ id: 0 }] }, { workItems: [{ id: 1 }, { id: 1 }] },
    { workItems: [{ id: 2 }, { id: 1 }] }, { queryType: 'tree', workItemRelations: [] },
    { workItemRelations: [{ target: { id: 1 } }] }, { queryType: 2, workItems: [] },
    { workItems: [{ id: 1 }], count: 0 },
    { workItems: [], count: '0' }, { workItems: [], hasMore: 'yes' },
    { workItems: [], complete: 'yes' }, { workItems: [], continuationToken: {} },
  ]) {
    await assert.rejects(load([record(1)], call => call.args.action === 'wiql' ? { result } : undefined), /Unsupported|pagination/)
  }
  await assert.rejects(load([record(1)], call => call.args.action === 'wiql' ? {
    result: { workItems: [{ id: 1 }, { id: 2 }] },
  } : undefined, { pageSize: 1 }), /exceeded/)
  await assert.rejects(load([record(1)], call => call.args.action === 'wiql' ? {
    result: { workItems: [{ id: 1 }] },
  } : undefined, { pageSize: 1 }), /strictly increasing/)
})

test('invalid hydration or type metadata is explicit rather than empty success', async () => {
  for (const result of [
    {}, { value: [{}] }, { value: [{ id: 1, fields: null }] },
    [record(2)], [record(1), record(1)],
    [record(1, { 'System.Title': undefined })], [record(1, { 'System.WorkItemType': 4 })],
    [record(1, { 'System.Tags': ['Blocked'] })], [record(1, { 'System.AssignedTo': {} })],
    [record(1, { 'System.AssignedTo': 42 })], [record(1, { 'System.TeamProject': {} })],
  ]) {
    await assert.rejects(load([record(1)], call => call.args.action === 'get_batch' ? { result } : undefined), /Unsupported/)
  }
  for (const result of [
    {}, '[]', { name: 'Task', states: [] }, { name: 'User Story', states: [null] },
    { name: 'User Story', states: [{ name: 'Doing', category: 5 }] },
    { name: 'User Story', states: [{ name: 'Doing' }, { name: 'Doing' }] },
  ]) {
    await assert.rejects(load([record(1)], call => call.args.action === 'get_type' ? { result } : undefined), /Unsupported|Ambiguous/)
  }
})

test('abort signals and provider failures propagate without returning a successful snapshot', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled before read'))
  const fixture = fakeMcp([])
  await assert.rejects(loadAdo(fixture.mcp, baseSource, baseOptions, controller.signal), /cancelled before read/)
  assert.equal(fixture.calls.length, 0)
  const during = new AbortController()
  await assert.rejects(loadAdo({
    async call() {
      during.abort(new Error('cancelled during read'))
      return { workItems: [] }
    },
  }, baseSource, baseOptions, during.signal), /cancelled during read/)
  await assert.rejects(loadAdo({
    async call() { throw new Error('ADO permission denied') },
  }, baseSource, baseOptions, new AbortController().signal), /ADO permission denied/)
})

test('invalid bounds and clock fail before the first MCP read', async () => {
  for (const options of [
    { maxItems: 0 }, { maxItems: 1.5 }, { pageSize: 0 }, { staleDays: -1 }, { staleDays: Infinity }, { now: () => new Date('invalid') },
  ]) {
    const fixture = fakeMcp()
    await assert.rejects(loadAdo(fixture.mcp, baseSource, { ...baseOptions, ...options }, new AbortController().signal), /Invalid ADO/)
    assert.equal(fixture.calls.length, 0)
  }
})
