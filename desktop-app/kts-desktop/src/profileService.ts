import { store } from "./appStore";
import { sessionStoreKeyForUser } from "./sessionStoreUser";

export async function updateProfilePreferredLanguage(
  preferredLanguageCode: string,
  userId: string,
): Promise<void> {
  const key = sessionStoreKeyForUser(userId, "preferredLanguageCode");
  await store.set(key, preferredLanguageCode);
  await store.save();
}
