import { GameRegion } from '../src/common';
import { JournalEventKind, GameLobbyStatus } from '../src/gametracker';
import { prepareJournal } from './thelpers';

describe('fallback to BasicPreview only if it\'s newer', () => {
    const journal = prepareJournal(GameRegion.KR, [
        { name: 'AD01', session: 1600108291 },
        { name: 'TA01', session: 1600115844 },
    ]);

    test('3400141', async () => {
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
                break;
            }
        }
        await journal.close();
    }, 10000);
});
