export function profileHandle(profile: { regionId: number, realmId: number, profileId: number }) {
    return `${profile.regionId}-S2-${profile.realmId}-${profile.profileId}`;
}
