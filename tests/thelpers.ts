import { GameRegion } from '../src/common';
import { JournalMultiProcessor } from '../src/gametracker';
import { JournalFeed } from '../src/journal/feed';

const TEST_LBSTREAM_SRC = '/mnt/d2/sc2arcade-data/lbstream';

export function prepareJournal(region: GameRegion, sources: { name: string, session: number }[]) {
    const journal = new JournalMultiProcessor(region);
    for (const src of sources) {
        journal.addFeedSource(new JournalFeed(
            `${TEST_LBSTREAM_SRC}/${src.name}-${GameRegion[region]}`, {
            initCursor: { session: src.session, offset: 0 },
            follow: false,
        }));
    }
    return journal;
}
