import { GameRegion } from '../common';

interface PlayerProfile {
    regionId: GameRegion;
    realmId: number;
    profileId: number;
}

export function profileHandle(profile: PlayerProfile) {
    return `${profile.regionId}-S2-${profile.realmId}-${profile.profileId}`;
}

export function parseProfileHandle(s: string): PlayerProfile {
    const m = s.match(/^(\d+)-S2-(\d+)-(\d+)$/);
    if (!m) return;
    const regionId = Number(m[1]) as GameRegion;
    if (!GameRegion[regionId]) return;
    const realmId = Number(m[2]);
    const profileId = Number(m[3]);
    return { regionId, realmId, profileId };
}
