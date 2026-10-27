/** Synthetic MCP evidence for native-profile browser/model tests; no network or workplace data. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const custom = process.argv[2] ? await import(pathToFileURL(resolve(process.argv[2])).href) : undefined
if (custom && typeof custom.fetch !== 'function') throw new Error('Custom synthetic source must export fetch(entityUrl)')
const customAdo = process.argv[3] ? await import(pathToFileURL(resolve(process.argv[3])).href) : undefined
if (customAdo && typeof customAdo.read !== 'function') throw new Error('Custom synthetic ADO source must export read(operation, args)')

const iterations = [
  { id: 'a1234567-1234-4234-a234-123456789012', name: 'Sprint A', path: 'Example\\Sprint A' },
  { id: 'b1234567-1234-4234-a234-123456789012', name: 'Sprint B', path: 'Example\\Sprint B' },
]
const items = [
  ...Array.from({ length: 5 }, (_, index) => ({ id: index + 1, path: iterations[0].path, done: index < 2 })),
  ...Array.from({ length: 8 }, (_, index) => ({ id: index + 101, path: iterations[1].path, done: index < 3 })),
].map(item => ({
  id: item.id,
  fields: {
    'System.Title': `Synthetic task ${item.id}`,
    'System.TeamProject': 'Example',
    'System.WorkItemType': 'Task',
    'System.State': item.done ? 'Closed' : 'Active',
    'System.AssignedTo': { id: item.id % 2 ? 'example-a' : 'example-b', displayName: item.id % 2 ? 'Alex Example' : 'Blair Example' },
    'System.AreaPath': 'Example',
    'System.IterationPath': item.path,
    'System.Tags': !item.done && item.id % 2 ? 'blocked' : '',
    'System.ChangedDate': '2026-01-01T00:00:00Z',
    'Microsoft.VSTS.Scheduling.StoryPoints': 2,
    'Microsoft.VSTS.Scheduling.RemainingWork': item.done ? 0 : 1,
  },
}))
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const server = new McpServer({ name: 'dashboard-synthetic-sources', version: '1.0.0' })

server.registerTool('fetch', { inputSchema: { entityUrls: z.array(z.string()) } }, async ({ entityUrls }) => {
  if (entityUrls.length !== 1) throw new Error('The synthetic WorkIQ fixture requires one resource')
  if (custom) return result({ results: [{ statusCode: 200, data: await custom.fetch(entityUrls[0]) }] })
  const path = entityUrls[0].split('?')[0]
  let data
  switch (path) {
    case '/me':
      data = { id: 'synthetic-profile', displayName: 'Synthetic Dashboard Account', mail: 'dashboard@example.invalid' }
      break
    case '/me/mailFolders/inbox':
      data = { id: 'inbox', unreadItemCount: 17, totalItemCount: 42 }
      break
    case '/me/messages':
    case '/me/calendarView':
    case '/me/mailFolders/inbox/messages':
    case '/me/chats':
    case '/me/drive/root/children':
      data = { value: [] }
      break
    default:
      throw new Error(`Unsupported synthetic WorkIQ path: ${path}`)
  }
  return result({ results: [{ statusCode: 200, data }] })
})

server.registerTool('work', {
  inputSchema: {
    action: z.string(), orgName: z.string(), project: z.string(),
    team: z.string().optional(), timeframe: z.string().optional(),
  },
}, async args => {
  const { action, orgName, project } = args
  if (orgName.toLowerCase() !== 'example' || project.toLowerCase() !== 'example') throw new Error('Synthetic source scope required')
  if (customAdo) return result(await customAdo.read('work', args))
  if (action !== 'list_team_iterations') throw new Error(`Unsupported synthetic work action: ${action}`)
  return result(iterations)
})

server.registerTool('wit_query', {
  inputSchema: {
    action: z.string(), orgName: z.string(), project: z.string(),
    wiql: z.string().optional(), id: z.string().optional(), top: z.number().optional(),
  },
}, async args => {
  const { action, orgName, project, wiql = '', top = 1000 } = args
  if (orgName.toLowerCase() !== 'example' || project.toLowerCase() !== 'example') throw new Error('Synthetic source scope required')
  if (customAdo) return result(await customAdo.read('wit_query', args))
  if (action !== 'wiql' && action !== 'get_results') throw new Error(`Unsupported synthetic query action: ${action}`)
  const path = /Sprint B/i.test(wiql) ? iterations[1].path : iterations[0].path
  const cursor = Number(/\[System\.Id\] > (\d+)/.exec(wiql)?.[1] ?? 0)
  return result({ workItems: items.filter(item => item.fields['System.IterationPath'] === path && item.id > cursor).slice(0, top).map(({ id }) => ({ id })) })
})

server.registerTool('wit_work_item', {
  inputSchema: {
    action: z.string(), orgName: z.string(), project: z.string(),
    team: z.string().optional(), iterationId: z.string().optional(),
    ids: z.array(z.number()).optional(), expand: z.string().optional(), workItemType: z.string().optional(),
    workItemId: z.number().optional(), skip: z.number().optional(), top: z.number().optional(),
  },
}, async args => {
  const { action, orgName, project, iterationId, ids, workItemType } = args
  if (orgName.toLowerCase() !== 'example' || project.toLowerCase() !== 'example') throw new Error('Synthetic source scope required')
  if (customAdo) return result(await customAdo.read('wit_work_item', args))
  switch (action) {
    case 'list_for_iteration': {
      const iteration = iterations.find(item => item.id === iterationId)
      if (!iteration) throw new Error('Unknown synthetic iteration')
      return result({ workItemRelations: items.filter(item => item.fields['System.IterationPath'] === iteration.path).map(item => ({ rel: null, source: null, target: { id: item.id } })) })
    }
    case 'get_batch':
      if (!ids || ids.some(id => !items.some(item => item.id === id))) throw new Error('Unknown synthetic work-item ID')
      return result(items.filter(item => ids.includes(item.id)))
    case 'get_type':
      if (workItemType !== 'Task') throw new Error('Unknown synthetic work-item type')
      return result({ name: 'Task', states: [{ name: 'Active', category: 'InProgress' }, { name: 'Closed', category: 'Completed' }] })
    default:
      throw new Error(`Unsupported synthetic work-item action: ${action}`)
  }
})

await server.connect(new StdioServerTransport())
