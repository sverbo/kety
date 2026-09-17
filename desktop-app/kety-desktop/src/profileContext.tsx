import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { store } from "./appStore";

export type LocalProfile = {
  id: string;
  name: string;
  createdAt: string;
};

type ProfileContextValue = {
  activeProfile: LocalProfile | null;
  profiles: LocalProfile[];
  profilesReady: boolean;
  createProfile: (name: string) => Promise<LocalProfile>;
  switchProfile: (id: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  updateProfileName: (id: string, name: string) => Promise<void>;
};

const PROFILES_STORE_KEY = "kts:profiles";
const ACTIVE_PROFILE_STORE_KEY = "kts:activeProfileId";

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profilesReady, setProfilesReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = (await store.get<LocalProfile[]>(PROFILES_STORE_KEY)) ?? [];
      const storedActiveId =
        (await store.get<string>(ACTIVE_PROFILE_STORE_KEY)) ?? null;
      if (cancelled) return;
      setProfiles(stored);
      const resolvedActiveId =
        storedActiveId && stored.some((p) => p.id === storedActiveId)
          ? storedActiveId
          : (stored[0]?.id ?? null);
      setActiveProfileId(resolvedActiveId);
      setProfilesReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    async (updated: LocalProfile[], activeId: string | null) => {
      await store.set(PROFILES_STORE_KEY, updated);
      await store.set(ACTIVE_PROFILE_STORE_KEY, activeId);
      await store.save();
    },
    [],
  );

  const createProfile = useCallback(
    async (name: string): Promise<LocalProfile> => {
      const profile: LocalProfile = {
        id: crypto.randomUUID(),
        name: name.trim() || "Profile",
        createdAt: new Date().toISOString(),
      };
      const updated = [...profiles, profile];
      setProfiles(updated);
      setActiveProfileId(profile.id);
      await persist(updated, profile.id);
      return profile;
    },
    [profiles, persist],
  );

  const switchProfile = useCallback(
    async (id: string) => {
      if (!profiles.some((p) => p.id === id)) return;
      setActiveProfileId(id);
      await store.set(ACTIVE_PROFILE_STORE_KEY, id);
      await store.save();
    },
    [profiles],
  );

  const deleteProfile = useCallback(
    async (id: string) => {
      const updated = profiles.filter((p) => p.id !== id);
      const newActive =
        activeProfileId === id ? (updated[0]?.id ?? null) : activeProfileId;
      setProfiles(updated);
      setActiveProfileId(newActive);
      await persist(updated, newActive);
    },
    [profiles, activeProfileId, persist],
  );

  const updateProfileName = useCallback(
    async (id: string, name: string) => {
      const updated = profiles.map((p) =>
        p.id === id ? { ...p, name: name.trim() || p.name } : p,
      );
      setProfiles(updated);
      await persist(updated, activeProfileId);
    },
    [profiles, activeProfileId, persist],
  );

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  const value = useMemo<ProfileContextValue>(
    () => ({
      activeProfile,
      profiles,
      profilesReady,
      createProfile,
      switchProfile,
      deleteProfile,
      updateProfileName,
    }),
    [
      activeProfile,
      profiles,
      profilesReady,
      createProfile,
      switchProfile,
      deleteProfile,
      updateProfileName,
    ],
  );

  return (
    <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used within ProfileProvider");
  return ctx;
}
