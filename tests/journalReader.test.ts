import { GameRegion, GameLobbyStatus } from '../src/common';
import { JournalEventKind, GameLobbySlotProfile } from '../src/gametracker';
import { prepareJournal } from './thelpers';

describe('fallback to BasicPreview only if it\'s newer', () => {
    const journal = prepareJournal(GameRegion.KR, [
        { name: 'AD01', session: 1600108291 },
        { name: 'TA01', session: 1600115844 },
    ]);

    test('3400141', async () => {
        const mockLobbyEvHandler = jest.fn();
        while (true) {
            const ev = await journal.proceed();
            if (!ev) break;
            if (ev.kind === JournalEventKind.CloseLobby && ev.lobby.initInfo.lobbyId === 3400141) {
                expect(ev.lobby.status).toBe(GameLobbyStatus.Started);
                expect(ev.lobby.slots).toHaveLength(4);
                expect(ev.lobby.slots[0].profile).toBeDefined();
                expect(ev.lobby.slots[1].profile).toBeDefined();
                expect(ev.lobby.slots[2].profile).toBeUndefined();
                expect(ev.lobby.slots[3].profile).toBeUndefined();
                mockLobbyEvHandler(ev);
                break;
            }
        }
        expect(mockLobbyEvHandler).toBeCalledTimes(1);
        await journal.close();
    }, 10000);
});

describe('restore player toon from incomplete lobby preview where slot positions have been shifted', () => {
    const journal = prepareJournal(GameRegion.EU, [
        { name: 'TX01', session: 1603828461 },
        { name: 'TA01', session: 1603827917 },
    ]);

    test('12835126 DS 6v6', async () => {
        const mockLobbyEvHandler = jest.fn();
        while (true) {
            const ev = await journal.proceed();
            if (!ev) break;
            if (ev.kind === JournalEventKind.CloseLobby && ev.lobby.initInfo.lobbyId === 12835126) {
                expect(ev.lobby.status).toBe(GameLobbyStatus.Started);
                expect(ev.lobby.slots).toHaveLength(6);
                ev.lobby.slots.forEach(slot => {
                    expect(slot.profile).toBeDefined();
                });
                expect(ev.lobby.slots[2].profile).toEqual<GameLobbySlotProfile>({
                    name: 'Ruppedup',
                    discriminator: 556,
                    regionId: 2,
                    realmId: 1,
                    profileId: 1043682,
                });
                expect(ev.lobby.slots[5].profile).toEqual<GameLobbySlotProfile>({
                    name: 'Monti',
                    discriminator: 299,
                    regionId: 2,
                    realmId: 1,
                    profileId: 8084407,
                });
                mockLobbyEvHandler(ev);
                break;
            }
        }
        expect(mockLobbyEvHandler).toBeCalledTimes(1);
        await journal.close();
    }, 10000);
});
