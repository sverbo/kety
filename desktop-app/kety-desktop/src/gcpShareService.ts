import { invoke } from "@tauri-apps/api/core";

export type GcpShareConfigInfo = {
  bucketName: string;
  clientEmail: string;
};

export type ShareLinkRow = {
  id: string;
  blobKey: string;
  downloadFilename: string;
  signedUrl: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

export async function getGcpShareConfig(userId: string): Promise<GcpShareConfigInfo | null> {
  return invoke("gcp_share_get_config_cmd", { userId });
}

export async function setGcpShareConfig(
  userId: string,
  bucketName: string,
  serviceAccountPath: string,
): Promise<GcpShareConfigInfo> {
  return invoke("gcp_share_set_config_cmd", { userId, bucketName, serviceAccountPath });
}

export async function removeGcpShareConfig(userId: string): Promise<void> {
  return invoke("gcp_share_remove_config_cmd", { userId });
}

export async function testGcpShareConnection(userId: string): Promise<void> {
  return invoke("gcp_share_test_connection_cmd", { userId });
}

export async function createShareLink(
  userId: string,
  sourcePath: string,
  downloadFilename: string,
  expirySeconds: number,
): Promise<ShareLinkRow> {
  return invoke("gcp_share_create_link_cmd", { userId, sourcePath, downloadFilename, expirySeconds });
}

export async function listShareLinks(userId: string): Promise<ShareLinkRow[]> {
  return invoke("gcp_share_list_links_cmd", { userId });
}

export async function revokeShareLink(userId: string, shareId: string): Promise<ShareLinkRow> {
  return invoke("gcp_share_revoke_link_cmd", { userId, shareId });
}
