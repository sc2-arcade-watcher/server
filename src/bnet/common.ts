export interface PlayerProfileParams {
    regionId: number;
    realmId: number;
    profileId: number;
}

export function profileHandle(profile: PlayerProfileParams) {
    return `${profile.regionId}-S2-${profile.realmId}-${profile.profileId}`;
}

export function parseProfileHandle(s: string): PlayerProfileParams | undefined {
    const m = s.trim().match(/^(\d+)-S2-(\d+)-(\d+)$/);
    if (!m) return;

    const regionId = Number(m[1]);
    const realmId = Number(m[2]);
    const profileId = Number(m[3]);

    if (regionId <= 0 || realmId <= 0 || profileId <= 0) return;

    return { regionId, realmId, profileId };
}
