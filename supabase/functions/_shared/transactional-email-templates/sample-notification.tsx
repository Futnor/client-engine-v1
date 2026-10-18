/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = "Client Engine"

interface SampleNotificationProps {
  name?: string
}

const SampleNotificationEmail = ({ name }: SampleNotificationProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>A notification from {SITE_NAME}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>
          {name ? `Hey ${name}!` : 'Hello!'}
        </Heading>
        <Text style={text}>
          This is a sample notification from {SITE_NAME}. Replace this template with your own content.
        </Text>
        <Text style={footer}>— The {SITE_NAME} Team</Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: SampleNotificationEmail,
  subject: 'Notification from Client Engine',
  displayName: 'Sample notification',
  previewData: { name: 'Jane' },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Inter, Arial, sans-serif' }
const container = { padding: '20px 25px' }
const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#0a0e1a', margin: '0 0 20px' }
const text = { fontSize: '14px', color: '#7a8199', lineHeight: '1.5', margin: '0 0 25px' }
const footer = { fontSize: '12px', color: '#999999', margin: '30px 0 0' }
