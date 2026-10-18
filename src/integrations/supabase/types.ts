export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_sessions: {
        Row: {
          anthropic_session_id: string
          created_at: string
          customer_identifier: string
          id: string
          last_message_at: string
          message_count: number
          platform: string
          user_id: string
        }
        Insert: {
          anthropic_session_id: string
          created_at?: string
          customer_identifier: string
          id?: string
          last_message_at?: string
          message_count?: number
          platform?: string
          user_id: string
        }
        Update: {
          anthropic_session_id?: string
          created_at?: string
          customer_identifier?: string
          id?: string
          last_message_at?: string
          message_count?: number
          platform?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_post_comment_usage: {
        Row: {
          count: number
          created_at: string
          id: string
          updated_at: string
          usage_date: string
          user_id: string
        }
        Insert: {
          count?: number
          created_at?: string
          id?: string
          updated_at?: string
          usage_date?: string
          user_id: string
        }
        Update: {
          count?: number
          created_at?: string
          id?: string
          updated_at?: string
          usage_date?: string
          user_id?: string
        }
        Relationships: []
      }
      api_keys: {
        Row: {
          created_at: string
          id: string
          key_hash: string
          key_prefix: string
          label: string
          last_used_at: string | null
          revoked: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_hash: string
          key_prefix: string
          label?: string
          last_used_at?: string | null
          revoked?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          key_hash?: string
          key_prefix?: string
          label?: string
          last_used_at?: string | null
          revoked?: boolean
          user_id?: string
        }
        Relationships: []
      }
      business_profiles: {
        Row: {
          agent_name: string
          business_name: string
          common_objections: string
          competitors: string
          created_at: string
          current_promos: string
          id: string
          is_active: boolean
          key_transformation: string
          pricing: string
          product: string
          target_customer: string
          updated_at: string
          user_id: string
          whatsapp_access_token: string | null
          whatsapp_phone_number_id: string | null
          whatsapp_verify_token: string | null
        }
        Insert: {
          agent_name?: string
          business_name?: string
          common_objections?: string
          competitors?: string
          created_at?: string
          current_promos?: string
          id?: string
          is_active?: boolean
          key_transformation?: string
          pricing?: string
          product?: string
          target_customer?: string
          updated_at?: string
          user_id: string
          whatsapp_access_token?: string | null
          whatsapp_phone_number_id?: string | null
          whatsapp_verify_token?: string | null
        }
        Update: {
          agent_name?: string
          business_name?: string
          common_objections?: string
          competitors?: string
          created_at?: string
          current_promos?: string
          id?: string
          is_active?: boolean
          key_transformation?: string
          pricing?: string
          product?: string
          target_customer?: string
          updated_at?: string
          user_id?: string
          whatsapp_access_token?: string | null
          whatsapp_phone_number_id?: string | null
          whatsapp_verify_token?: string | null
        }
        Relationships: []
      }
      dm_tracking: {
        Row: {
          created_at: string
          id: string
          instagram_account_username: string | null
          platform: string
          recipient_username: string
          responded: boolean
          responded_at: string | null
          sent_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          instagram_account_username?: string | null
          platform?: string
          recipient_username: string
          responded?: boolean
          responded_at?: string | null
          sent_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          instagram_account_username?: string | null
          platform?: string
          recipient_username?: string
          responded?: boolean
          responded_at?: string | null
          sent_at?: string
          user_id?: string
        }
        Relationships: []
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      orphan_backup_20260902: {
        Row: {
          backed_up_at: string | null
          row_id: string | null
          table_name: string | null
        }
        Insert: {
          backed_up_at?: string | null
          row_id?: string | null
          table_name?: string | null
        }
        Update: {
          backed_up_at?: string | null
          row_id?: string | null
          table_name?: string | null
        }
        Relationships: []
      }
      outreach_profiles: {
        Row: {
          ai_description: string | null
          content_tags: string[] | null
          created_at: string
          custom_message: string | null
          id: string
          image_url: string
          is_active: boolean | null
          platform: string
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_description?: string | null
          content_tags?: string[] | null
          created_at?: string
          custom_message?: string | null
          id?: string
          image_url: string
          is_active?: boolean | null
          platform?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_description?: string | null
          content_tags?: string[] | null
          created_at?: string
          custom_message?: string | null
          id?: string
          image_url?: string
          is_active?: boolean | null
          platform?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      outreach_queue: {
        Row: {
          created_at: string
          custom_message: string | null
          id: string
          instagram_username: string | null
          match_reason: string | null
          match_score: number | null
          platform: string
          profile_id: string | null
          status: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          custom_message?: string | null
          id?: string
          instagram_username?: string | null
          match_reason?: string | null
          match_score?: number | null
          platform?: string
          profile_id?: string | null
          status?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          custom_message?: string | null
          id?: string
          instagram_username?: string | null
          match_reason?: string | null
          match_score?: number | null
          platform?: string
          profile_id?: string | null
          status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "outreach_queue_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "outreach_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          instagram_username: string | null
          tiktok_username: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          instagram_username?: string | null
          tiktok_username?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          instagram_username?: string | null
          tiktok_username?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      session_history: {
        Row: {
          created_at: string
          dms_sent: number
          duration_seconds: number
          ended_at: string | null
          follows_sent: number
          id: string
          instagram_account_username: string | null
          likes_sent: number
          platform: string
          scrolls: number
          started_at: string
          targeting_mode: string
          user_id: string
        }
        Insert: {
          created_at?: string
          dms_sent?: number
          duration_seconds?: number
          ended_at?: string | null
          follows_sent?: number
          id?: string
          instagram_account_username?: string | null
          likes_sent?: number
          platform?: string
          scrolls?: number
          started_at?: string
          targeting_mode?: string
          user_id: string
        }
        Update: {
          created_at?: string
          dms_sent?: number
          duration_seconds?: number
          ended_at?: string | null
          follows_sent?: number
          id?: string
          instagram_account_username?: string | null
          likes_sent?: number
          platform?: string
          scrolls?: number
          started_at?: string
          targeting_mode?: string
          user_id?: string
        }
        Relationships: []
      }
      support_ticket_replies: {
        Row: {
          admin_user_id: string | null
          created_at: string
          email_sent: boolean
          from_admin: boolean
          id: string
          message: string
          ticket_id: string
        }
        Insert: {
          admin_user_id?: string | null
          created_at?: string
          email_sent?: boolean
          from_admin: boolean
          id?: string
          message: string
          ticket_id: string
        }
        Update: {
          admin_user_id?: string | null
          created_at?: string
          email_sent?: boolean
          from_admin?: boolean
          id?: string
          message?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_ticket_replies_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          created_at: string
          email: string
          id: string
          message: string
          status: string
          subject: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          message: string
          status?: string
          subject?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          message?: string
          status?: string
          subject?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      trial_claims: {
        Row: {
          claimed_at: string
          email: string | null
          id: string
          ip_address: string
          stripe_customer_id: string | null
          user_id: string
        }
        Insert: {
          claimed_at?: string
          email?: string | null
          id?: string
          ip_address: string
          stripe_customer_id?: string | null
          user_id: string
        }
        Update: {
          claimed_at?: string
          email?: string | null
          id?: string
          ip_address?: string
          stripe_customer_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      email_queue_dispatch: { Args: never; Returns: undefined }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      is_support_admin: { Args: never; Returns: boolean }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
