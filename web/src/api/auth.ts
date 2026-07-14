import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";

export interface Me {
  username: string;
}

export interface LoginPayload {
  username: string;
  password: string;
}

/** Query key + fetcher for `GET /auth/me`, shared by `useAuth` and the
 * authenticated layout route's `beforeLoad` guard (see `src/routes.tsx`). */
export const authQueryOptions = queryOptions({
  queryKey: ["auth", "me"] as const,
  queryFn: () => api.get<Me>("/auth/me"),
  retry: false,
});

/** Bootstraps auth state from `GET /auth/me`. */
export function useAuth() {
  return useQuery(authQueryOptions);
}

/** `POST /auth/login`, then invalidates the `me` query so consumers refetch. */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: LoginPayload) => api.post<void>("/auth/login", payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authQueryOptions.queryKey }),
  });
}

/** `POST /auth/logout`, then clears the cached `me` query. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => queryClient.setQueryData(authQueryOptions.queryKey, undefined),
  });
}

export interface ChangePasswordPayload {
  current_password: string;
  new_password: string;
}

/** `POST /auth/password` (Round 10 T4): rotates the admin's password hash
 * and deletes every OTHER session for this user server-side. The current
 * session (and its cookie) stays valid on success, so no client-side
 * session/redirect handling is needed here beyond the request itself. */
export function useChangePassword() {
  return useMutation({
    mutationFn: (payload: ChangePasswordPayload) => api.post<void>("/auth/password", payload),
  });
}
