export const visionAskParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: {
    attachmentId: {
      type: 'string',
      description: 'Attachment id of an image in this conversation (from the injected description).',
    },
    path: {
      type: 'string',
      description: 'Absolute or workspace-relative local image file path.',
    },
    question: {
      type: 'string',
      description: 'The specific question to answer about the image.',
    },
  },
} as const
