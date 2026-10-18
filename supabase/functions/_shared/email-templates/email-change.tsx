/// <reference types="npm:@types/react@18.3.1" />

import * as React from 'npm:react@18.3.1'

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'

interface EmailChangeEmailProps {
  siteName: string
  email: string
  newEmail: string
  confirmationUrl: string
}

const LOGO_URL = 'https://YOUR_SUPABASE_PROJECT_REF.supabase.co/storage/v1/object/public/email-assets/logo.png'

export const EmailChangeEmail = ({
  siteName,
  email,
  newEmail,
  confirmationUrl,
}: EmailChangeEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Confirm your email change for {siteName}</Preview>
    <Body style={main}>
      <Container style={wrapper}>
        <Section style={header}>
          <Img src={LOGO_URL} width="48" height="48" alt={siteName} style={logo} />
          <Text style={brandName}>{siteName}</Text>
        </Section>
        <Hr style={divider} />
        <Section style={content}>
          <Heading style={h1}>Confirm email change ✉️</Heading>
          <Text style={text}>
            You requested to change your email address for {siteName} from <strong>{email}</strong> to <strong>{newEmail}</strong>.
          </Text>
          <Text style={text}>
            Click the button below to confirm this change:
          </Text>
          <Section style={buttonContainer}>
            <Button style={button} href={confirmationUrl}>
              Confirm Email Change
            </Button>
          </Section>
          <Text style={subtext}>
            If the button doesn't work, copy and paste this URL into your browser:
          </Text>
          <Text style={urlText}>{confirmationUrl}</Text>
        </Section>
        <Hr style={divider} />
        <Section style={footerSection}>
          <Text style={footer}>
            If you didn't request this change, please secure your account immediately.
          </Text>
          <Text style={footerBrand}>© {siteName} — AI-Powered Client Acquisition</Text>
        </Section>
      </Container>
    </Body>
  </Html>
)

export default EmailChangeEmail

const main = { backgroundColor: '#f4f4f5', fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', padding: '40px 0' }
const wrapper = { backgroundColor: '#ffffff', borderRadius: '12px', maxWidth: '520px', margin: '0 auto', overflow: 'hidden' as const, border: '1px solid #e4e4e7' }
const header = { padding: '32px 40px 20px', textAlign: 'center' as const }
const logo = { borderRadius: '10px', display: 'inline-block' as const }
const brandName = { fontSize: '18px', fontWeight: '700' as const, color: '#0a0e1a', margin: '12px 0 0', letterSpacing: '-0.3px' }
const divider = { borderColor: '#e4e4e7', margin: '0' }
const content = { padding: '32px 40px' }
const h1 = { fontSize: '24px', fontWeight: '700' as const, color: '#0a0e1a', margin: '0 0 16px', lineHeight: '1.3' }
const text = { fontSize: '15px', color: '#3f3f46', lineHeight: '1.6', margin: '0 0 20px' }
const buttonContainer = { textAlign: 'center' as const, margin: '28px 0' }
const button = { backgroundColor: '#0891b2', color: '#ffffff', fontSize: '15px', fontWeight: '600' as const, borderRadius: '10px', padding: '14px 32px', textDecoration: 'none', display: 'inline-block' as const }
const subtext = { fontSize: '13px', color: '#71717a', lineHeight: '1.5', margin: '0 0 8px' }
const urlText = { fontSize: '12px', color: '#a1a1aa', lineHeight: '1.4', margin: '0 0 20px', wordBreak: 'break-all' as const }
const footerSection = { padding: '24px 40px' }
const footer = { fontSize: '13px', color: '#a1a1aa', lineHeight: '1.5', margin: '0 0 8px', textAlign: 'center' as const }
const footerBrand = { fontSize: '12px', color: '#d4d4d8', margin: '0', textAlign: 'center' as const }
