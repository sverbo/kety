/** Share types — kept for Phase 5 (GCP bucket sharing). Functions are stubbed (no backend). */

export type ShareRow = {
  id: string;
  ai_assistant_user_id: string;
  shared_with_user_id: string;
  ai_assistant_nickname?: string | null;
  suspended_at: string | null;
  created_at: string;
  counterparty_display_name: string;
};

export type ShareContactRow = {
  user_id: string;
  display_name?: string | null;
  assistant_incoming_share_id?: string | null;
  assistant_outgoing_share_id?: string | null;
  assistant_incoming_nickname?: string | null;
  assistant_outgoing_nickname?: string | null;
  assistant_incoming_active?: boolean;
  assistant_incoming_suspended?: boolean;
  assistant_outgoing_active?: boolean;
  assistant_outgoing_suspended?: boolean;
  reporting_incoming_active?: boolean;
  reporting_incoming_suspended?: boolean;
  reporting_outgoing_active?: boolean;
  reporting_outgoing_suspended?: boolean;
  segment_tag_ids?: string[] | null;
};

export async function fetchShareContacts(): Promise<ShareContactRow[]> {
  return [];
}

export async function createShare(
  _sharedWithUserId: string,
): Promise<ShareRow> {
  throw new Error("Share assistant is not yet available in local mode.");
}

export async function suspendShare(_shareId: string): Promise<void> {}

export async function unsuspendShare(_shareId: string): Promise<void> {}

export async function deleteShare(_shareId: string): Promise<void> {}

export async function updateIncomingShareNickname(
  _assistantOwnerId: string,
  _aiAssistantNickname: string | null,
): Promise<void> {}

export async function updateShareTagFilter(
  _shareId: string,
  _segmentTagIds: string[] | null,
): Promise<void> {}
