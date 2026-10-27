/**
 * Harness request-history conversion into pi-ai context.
 */

import {
  contentHasImage,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requiredImageOffload,
  requestImageHandleText,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccessResolver,
  RequestMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type {
  AssistantMessage,
  Context as PiContext,
  ImageContent,
  Message as PiMessage,
  TextContent,
  ThinkingContent,
  Tool as PiTool,
  ToolCall,
} from '@earendil-works/pi-ai'

const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048

function flattenText(message: RequestMessage): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => {
    if (block.type === 'text') return block.text
    return ''
  }).join('')
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // tolerate malformed historical arguments
  }
  return {}
}

function assertSupportedImageRoles(messages: readonly RequestMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(
        `pi-ai cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

async function userContent(
  blocks: readonly ContentBlock[],
  requestImages: ReadonlyMap<AttachmentId, RequestImageAttachment>,
  resolveImageAccess: ImageAttachmentAccessResolver,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = requestImages.get(block.attachment.attachmentId) as RequestImageAttachment
        content.push({
          type: 'text',
          text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
        })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      default:
        break
    }
  }
  if (content.every(block => block.type === 'text')) {
    return content.map(block => block.text).join('')
  }
  return content
}

function collectImageRefs(
  blocks: readonly ContentBlock[],
  refs: Map<AttachmentId, ImageAttachmentRef>,
): void {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
  }
}

async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore,
  policy: { maxPixels: number; maxBytes: number },
  signal?: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const prepared = await Promise.all(orderedRefs.map(
    ref => attachments.readImageRequest(ref, {
      ...requestImageDimensions(ref.width, ref.height, policy.maxPixels),
      maxBytes: policy.maxBytes,
    }, signal),
  ))
  const versions = new Map<AttachmentId, RequestImageAttachment>()
  for (const [index, ref] of orderedRefs.entries()) {
    versions.set(ref.attachmentId, prepared[index] as RequestImageAttachment)
  }
  return versions
}

function emptyUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function toAssistant(
  message: Extract<RequestMessage, { role: 'assistant' }>,
  fallback: { provider: string, model: string },
): AssistantMessage {
  const content: Array<TextContent | ThinkingContent | ToolCall> = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text })
    else if (block.type === 'tool-call') {
      content.push({
        type: 'toolCall',
        id: String(block.id),
        name: block.name,
        arguments: parseArguments(block.arguments),
      })
    }
  }
  const source = message.source.kind === 'model' ? message.source : fallback
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: source.provider,
    model: source.model,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: 0,
  }
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function textOnlyContext(options: GenerateOptions): PiContext {
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []

  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError(
        'dsh-llm-oauth image conversion requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toAssistant(message, {
        provider: options.provider,
        model: options.model,
      })
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }

    if (message.role === 'tool') {
      messages.push({
        role: 'toolResult',
        toolCallId: String(message.toolCallId),
        toolName: toolNames.get(String(message.toolCallId)) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(message.content) || '(no output)' }],
        isError: message.isError === true,
        timestamp: 0,
      })
    } else {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
    }
  }

  return piContext(options, messages)
}

/** Inputs required to resolve durable DSH image attachments for one request. */
export interface PiImageRequestContext {
  attachments: AttachmentStore
  resolveImageAccess: ImageAttachmentAccessResolver
  maxRequestImageBytes?: number
  requestImagePolicy?: { maxPixels: number; maxBytes: number }
}

/**
 * Convert one assembled harness request into pi-ai's context envelope.
 * @param options - fully assembled model request.
 * @param images - optional durable image resolution context.
 */
export function toPiContext(options: GenerateOptions, images?: undefined): PiContext
export function toPiContext(options: GenerateOptions, images: PiImageRequestContext): Promise<PiContext>
export function toPiContext(
  options: GenerateOptions,
  images?: PiImageRequestContext,
): PiContext | Promise<PiContext> {
  return images === undefined ? textOnlyContext(options) : toPiContextWithImages(options, images)
}

async function toPiContextWithImages(
  options: GenerateOptions,
  images: PiImageRequestContext,
): Promise<PiContext> {
  const requestImagePolicy = images.requestImagePolicy ?? {
    maxPixels: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
  assertSupportedImageRoles(options.messages)
  const offloadCount = requiredImageOffload(options.messages, {
    representation: 'base64',
    maxBytes: images.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    byteQuantum: 1,
  }, block => Math.min(block.attachment.bytes, requestImagePolicy.maxBytes))
  if (offloadCount > 0) throw new LlmError(
    `The request needs ${String(offloadCount)} additional image occurrence(s) offloaded.`,
    'IMAGE_OFFLOAD_REQUIRED',
  )
  const requestMessages = projectOffloadedImages(
    options.messages,
    ref => offloadedImageText(ref, images.resolveImageAccess(ref)),
  )
  const requestImages = await prepareRequestImages(
    requestMessages,
    images.attachments,
    requestImagePolicy,
    options.signal,
  )
  const exactOffloadCount = requiredImageOffload(requestMessages, {
    representation: 'base64',
    maxBytes: images.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    byteQuantum: 1,
  }, block => (requestImages.get(block.attachment.attachmentId) as RequestImageAttachment).bytes)
  if (exactOffloadCount > 0) throw new LlmError(
    `The request needs ${String(exactOffloadCount)} additional image occurrence(s) offloaded.`,
    'IMAGE_OFFLOAD_REQUIRED',
  )
  const exactMessages = requestMessages
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []

  for (const message of exactMessages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toAssistant(message, {
        provider: options.provider,
        model: options.model,
      })
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }

    const content = await userContent(message.content, requestImages, images.resolveImageAccess)
    if (message.role === 'tool') {
      messages.push({
        role: 'toolResult',
        toolCallId: String(message.toolCallId),
        toolName: toolNames.get(String(message.toolCallId)) ?? 'unknown',
        content: typeof content === 'string'
          ? [{ type: 'text', text: content || '(no output)' }]
          : content,
        isError: message.isError === true,
        timestamp: 0,
      })
    } else {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
  }

  return piContext(options, messages)
}
