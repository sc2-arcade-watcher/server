import { GameRegion } from '../src/common';
import { JournalMultiProcessor } from '../src/gametracker';
import { JournalFeed } from '../src/journal/feed';

export function prepareJournal(region: GameRegion, sources: { name: string, session: number }[]) {
    const journal = new JournalMultiProcessor(region);
    for (const src of sources) {
        journal.addFeedSource(new JournalFeed(
            `data/lbstream-ext/${src.name}-${GameRegion[region]}`, {
            initCursor: { session: src.session, offset: 0 },
            follow: false,
        }));
    }
    return journal;
}
