/**
 * Compatibility wrapper around ProfileProvider.
 * Exposes the same useAuth() interface as before so call sites can be
 * migrated incrementally in Phase 2/3. No Supabase, no backend calls.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { ProfileProvider, useProfile } from "./profileContext";
import { ProfileSetupScreen } from "./ProfileSetupScreen";

/** Generic fetch signature threaded through components that historically called the (now-removed) backend. */
export type BackendFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Minimal session type — replaces @supabase/supabase-js Session. */
export type KtsSession = {
  user: {
    id: string;
    email: string | null;
  };
  access_token: string;
};

export type UserProfileRow = {
  isSuperAdmin: boolean;
  /** Always "local" in local-only mode — all features unlocked. */
  plan: string | null;
  planDisplayName: string | null;
  preferredLanguageCode: string | null;
};

export function userPlanLabel(_profile: UserProfileRow | null | undefined): string {
  return "Local";
}

export function isSubscriptionFree(
  profile: UserProfileRow | null | undefined,
): boolean {
  if (profile == null) return true;
  const s = profile.plan?.trim().toLowerCase();
  if (s == null || s === "") return true;
  return s === "free";
}

export function isSubscriptionLight(
  profile: UserProfileRow | null | undefined,
): boolean {
  if (profile == null) return false;
  return profile.plan?.trim().toLowerCase() === "light";
}

export function isSubscriptionPremium(
  profile: UserProfileRow | null | undefined,
): boolean {
  if (profile == null) return false;
  return !isSubscriptionFree(profile) && !isSubscriptionLight(profile);
}

type AuthContextValue = {
  session: KtsSession | null;
  authReady: boolean;
  profile: UserProfileRow | null;
  profileReady: boolean;
  refreshProfile: () => Promise<void>;
  isSuperAdmin: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  authModalOpen: boolean;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  authenticatedFetch: BackendFetchFn;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const LOCAL_PROFILE_ROW: UserProfileRow = {
  isSuperAdmin: false,
  plan: "local",
  planDisplayName: "Local",
  preferredLanguageCode: null,
};

function AuthProviderInner({ children }: { children: ReactNode }) {
  const { activeProfile, profilesReady } = useProfile();

  const session = useMemo<KtsSession | null>(
    () =>
      activeProfile
        ? { user: { id: activeProfile.id, email: null }, access_token: "" }
        : null,
    [activeProfile],
  );

  const profile = activeProfile ? LOCAL_PROFILE_ROW : null;

  const authenticatedFetch = useCallback<BackendFetchFn>(
    (input, init) => fetch(input, init),
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      authReady: profilesReady,
      profile,
      profileReady: profilesReady,
      refreshProfile: async () => {},
      isSuperAdmin: false,
      signIn: async () => ({ error: null }),
      signOut: async () => {},
      authModalOpen: false,
      openAuthModal: () => {},
      closeAuthModal: () => {},
      authenticatedFetch,
    }),
    [session, profilesReady, profile, authenticatedFetch],
  );

  if (profilesReady && !activeProfile) {
    return <ProfileSetupScreen />;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <ProfileProvider>
      <AuthProviderInner>{children}</AuthProviderInner>
    </ProfileProvider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
