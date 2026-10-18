import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = "Client Engine"

interface AdminMessageProps {
  subject?: string
  body?: string
  name?: string
}

const AdminMessageEmail = ({ subject, body, name }: AdminMessageProps) => {
  const lines = (body || '').split(/\n+/).filter(Boolean)
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{subject || `A message from the ${SITE_NAME} team`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{name ? `Hi ${name},` : 'Hi,'}</Heading>
          {lines.map((line, i) => (
            <Text key={i} style={text}>{line}</Text>
          ))}
          <Text style={footer}>— The {SITE_NAME} Team</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  component: AdminMessageEmail,
  subject: (data: Record<string, any>) =>
    (data?.subject as string) || `A message from the ${SITE_NAME} team`,
  displayName: 'Admin message',
  previewData: { subject: 'Quick update', body: 'Just wanted to reach out and say hi.\nLet me know if you have any questions.', name: 'Sarah' },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '24px 28px', maxWidth: '560px' }
const h1 = { fontSize: '20px', fontWeight: 'bold', color: '#0f172a', margin: '0 0 18px' }
const text = { fontSize: '14px', color: '#334155', lineHeight: '1.6', margin: '0 0 14px' }
const footer = { fontSize: '13px', color: '#64748b', margin: '28px 0 0' }
