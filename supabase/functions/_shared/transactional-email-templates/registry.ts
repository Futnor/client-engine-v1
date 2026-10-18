/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'

export interface TemplateEntry {
  component: React.ComponentType<any>
  subject: string | ((data: Record<string, any>) => string)
  to?: string
  displayName?: string
  previewData?: Record<string, any>
}

import { template as sampleNotification } from './sample-notification.tsx'
import { template as adminMessage } from './admin-message.tsx'

export const TEMPLATES: Record<string, TemplateEntry> = {
  'sample-notification': sampleNotification,
  'admin-message': adminMessage,
}
