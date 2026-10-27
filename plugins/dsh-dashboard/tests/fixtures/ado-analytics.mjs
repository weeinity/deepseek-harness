/** Synthetic rolling sprint evidence; the explicit clock keeps unit expectations independent of wall time. */
export function createAdoAnalyticsFixture(asOf) {
  const clock = Date.parse(asOf)
  if (!Number.isFinite(clock)) throw new Error('Synthetic fixture requires an ISO clock')
  const ago = days => new Date(clock - days * 86_400_000).toISOString()
  const iteration = {
    id: 'a1234567-1234-4234-a234-123456789012', name: 'Sprint A', path: 'Example\\Sprint A',
    attributes: { startDate: `${ago(28).slice(0, 10)}T00:00:00Z`, finishDate: `${ago(-2).slice(0, 10)}T00:00:00Z` },
  }
  const iterationB = { ...iteration, id: 'b1234567-1234-4234-a234-123456789012', name: 'Sprint B', path: 'Example\\Sprint B' }
  const states = [
    { name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' },
    { name: 'Resolved', category: 'Resolved' }, { name: 'Closed', category: 'Completed' },
    { name: 'Removed', category: 'Removed' },
  ]
  const names = ['Alex Example', 'Blair Example', 'Casey Example', 'Devon Example']
  const items = Array.from({ length: 20 }, (_, index) => {
    const id = index + 1
    const type = id <= 18 ? 'Task' : 'Bug'
    const state = id <= 6 ? 'Closed' : id <= 10 ? 'New' : id <= 14 ? 'Active'
      : id <= 16 ? 'Resolved' : id === 17 ? 'Unmapped' : id === 18 ? 'Removed' : 'Active'
    const ages = [4, 12, 24, 45]
    const age = ages[index % ages.length]
    const stateAge = Math.max(1, age - 3)
    const owner = id === 8 ? undefined : { id: `example-${index % 4}`, displayName: names[index % 4] }
    const predecessor = id === 11 ? 12 : id === 12 ? 11 : id === 13 ? 999 : id === 14 ? 1 : undefined
    const fields = {
      'System.Id': id, 'System.TeamProject': 'Example', 'System.Title': `Synthetic ${type.toLowerCase()} ${id}`,
      'System.WorkItemType': type, 'System.State': state, 'System.AreaPath': `Example\\${index % 2 ? 'Delivery' : 'Platform'}`,
      'System.IterationPath': iteration.path, 'System.CreatedDate': ago(age), 'System.ChangedDate': ago(stateAge),
      'Microsoft.VSTS.Common.StateChangeDate': ago(stateAge), 'System.Tags': id === 7 || id === 11 ? 'blocked' : 'synthetic',
      'Microsoft.VSTS.Common.Priority': 1 + index % 3,
      'Microsoft.VSTS.Scheduling.StoryPoints': 1 + index % 5,
      'Microsoft.VSTS.Scheduling.RemainingWork': state === 'Closed' ? 0 : 1 + index % 8,
      ...(owner ? { 'System.AssignedTo': owner } : {}),
      ...(id === 9 ? { 'Custom.DueDate': ago(2) } : {}),
    }
    const revisions = [
      { id, rev: 1, fields: { ...fields, 'System.State': 'New', 'System.ChangedDate': ago(age) } },
      { id, rev: 2, fields: { ...fields, 'System.State': 'Active', 'System.ChangedDate': ago(age - 1) } },
      { id, rev: 3, fields },
    ]
    if (id === 1) {
      revisions[1].fields['System.State'] = 'Closed'
      revisions[2].fields['System.State'] = 'Active'
      revisions.push({ id, rev: 4, fields: {
        ...fields, 'System.State': 'Closed', 'System.ChangedDate': ago(0.5),
        'Microsoft.VSTS.Common.StateChangeDate': ago(0.5),
      } })
    }
    const current = revisions.at(-1)
    return {
      ...current,
      relations: predecessor === undefined ? [] : [{
        rel: 'System.LinkTypes.Dependency-Reverse',
        url: `https://dev.azure.com/example/Example/_apis/wit/workItems/${predecessor}`,
      }],
      revisions,
    }
  })
  const second = items.slice(0, 8).map((original, index) => {
    const item = structuredClone(original)
    item.id = index + 101
    for (const revision of item.revisions) {
      revision.id = item.id
      revision.fields['System.Id'] = item.id
      revision.fields['System.Title'] = `Synthetic task ${item.id}`
      revision.fields['System.IterationPath'] = iterationB.path
    }
    item.fields['System.State'] = index < 3 ? 'Closed' : 'Active'
    return item
  })
  items.push(...second)
  return {
    async read(operation, args) {
      if (args.orgName.toLowerCase() !== 'example' || args.project.toLowerCase() !== 'example') {
        throw new Error('Synthetic ADO scope required')
      }
      if (operation === 'work' && args.action === 'list_team_iterations') return [iteration, iterationB]
      if (operation === 'wit_query' && args.action === 'wiql') {
        const cursor = Number(/\[System\.Id\] > (\d+)/.exec(args.wiql)?.[1] ?? 0)
        const path = args.wiql.includes('Sprint B') ? iterationB.path : iteration.path
        return { workItems: items.filter(item => item.id > cursor && item.fields['System.IterationPath'] === path)
          .slice(0, args.top).map(item => ({ id: item.id })) }
      }
      if (operation === 'wit_work_item') {
        switch (args.action) {
          case 'list_for_iteration':
            if (args.iterationId !== iteration.id && args.iterationId !== iterationB.id) throw new Error('Unknown synthetic sprint')
            return { workItemRelations: items.filter(item => item.fields['System.IterationPath'] ===
              (args.iterationId === iteration.id ? iteration.path : iterationB.path))
              .map(item => ({ rel: null, source: null, target: { id: item.id } })) }
          case 'get_batch':
            if (!args.ids || args.ids.some(id => !items.some(item => item.id === id))) throw new Error('Unknown synthetic item')
            return items.filter(item => args.ids.includes(item.id)).map(({ revisions: _revisions, ...item }) => item)
          case 'get_type':
            if (!['Task', 'Bug'].includes(args.workItemType)) throw new Error('Unknown synthetic type')
            return { name: args.workItemType, states }
          case 'list_revisions': {
            const item = items.find(item => item.id === args.workItemId)
            if (!item) throw new Error('Unknown synthetic revision item')
            if (!Number.isInteger(args.skip) || !Number.isInteger(args.top) || args.skip < 0 || args.top < 1 || args.top > 200) {
              throw new Error('Synthetic revision reads require bounded paging')
            }
            return item.revisions.slice(args.skip, args.skip + args.top)
          }
        }
      }
      throw new Error(`Unsupported synthetic ADO operation: ${operation}/${args.action}`)
    },
  }
}

const fixture = createAdoAnalyticsFixture(new Date().toISOString())
export const read = fixture.read
