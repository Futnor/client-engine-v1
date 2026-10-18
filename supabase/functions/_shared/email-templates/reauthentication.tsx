/// <reference types="npm:@types/react@18.3.1" />

import * as React from 'npm:react@18.3.1'

import {
  Body,
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

interface ReauthenticationEmailProps {
  token: string
}

const LOGO_URL = 'https://YOUR_SUPABASE_PROJECT_REF.supabase.co/storage/v1/object/public/email-assets/logo.png'
const SITE_NAME = 'Client Engine'

export const ReauthenticationEmail = ({ token }: ReauthenticationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your verification code for {SITE_NAME}</Preview>
    <Body style={main}>
      <Container style={wrapper}>
        <Section style={header}>
          <Img src={LOGO_URL} width="48" height="48" alt={SITE_NAME} style={logo} />
          <Text style={brandName}>{SITE_NAME}</Text>
        </Section>
        <Hr style={divider} />
        <Section style={content}>
          <Heading style={h1}>Verification code 🔑</Heading>
          <Text style={text}>Use the code below to confirm your identity:</Text>
          <Section style={codeContainer}>
            <Text style={codeStyle}>{token}</Text>
          </Section>
          <Text style={subtext}>This code will expire shortly. Do not share it with anyone.</Text>
        </Section>
        <Hr style={divider} />
        <Section style={footerSection}>
          <Text style={footer}>
            If you didn't request this code, you can safely ignore this email.
          </Text>
          <Text style={footerBrand}>© {SITE_NAME} — AI-Powered Client Acquisition</Text>
        </Section>
      </Container>
    </Body>
  </Html>
)

export default ReauthenticationEmail

const main = { backgroundColor: '#f4f4f5', fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', padding: '40px 0' }
const wrapper = { backgroundColor: '#ffffff', borderRadius: '12px', maxWidth: '520px', margin: '0 auto', overflow: 'hidden' as const, border: '1px solid #e4e4e7' }
const header = { padding: '32px 40px 20px', textAlign: 'center' as const }
const logo = { borderRadius: '10px', display: 'inline-block' as const }
const brandName = { fontSize: '18px', fontWeight: '700' as const, color: '#0a0e1a', margin: '12px 0 0', letterSpacing: '-0.3px' }
const divider = { borderColor: '#e4e4e7', margin: '0' }
const content = { padding: '32px 40px' }
const h1 = { fontSize: '24px', fontWeight: '700' as const, color: '#0a0e1a', margin: '0 0 16px', lineHeight: '1.3' }
const text = { fontSize: '15px', color: '#3f3f46', lineHeight: '1.6', margin: '0 0 20px' }
const codeContainer = { backgroundColor: '#f4f4f5', borderRadius: '10px', padding: '20px', textAlign: 'center' as const, margin: '0 0 20px', border: '1px solid #e4e4e7' }
const codeStyle = { fontFamily: '"JetBrains Mono", "Fira Code", Courier, monospace', fontSize: '32px', fontWeight: '700' as const, color: '#0891b2', margin: '0', letterSpacing: '6px' }
const subtext = { fontSize: '13px', color: '#71717a', lineHeight: '1.5', margin: '0 0 8px' }
const footerSection = { padding: '24px 40px' }
const footer = { fontSize: '13px', color: '#a1a1aa', lineHeight: '1.5', margin: '0 0 8px', textAlign: 'center' as const }
const footerBrand = { fontSize: '12px', color: '#d4d4d8', margin: '0', textAlign: 'center' as const }
