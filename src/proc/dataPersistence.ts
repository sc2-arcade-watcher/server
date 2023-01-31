import * as orm from 'typeorm';
import { oneLine } from 'common-tags';
import { Worker, Job, QueueScheduler, Queue } from 'bullmq';
import { logger } from '../logger';
import { ServiceProcess } from './process';
import { createDataRecordWorker, DataRecordType, DataRecordKind, MapReviews, ProfileDiscover, createDataRecordScheduler, createDataRecordQueue } from '../server/runnerExchange';
import { S2Profile } from '../entity/S2Profile';
import { S2ProfileTracking } from '../entity/S2ProfileTracking';
import { localProfileId } from '../common';
import { ProfileManager } from '../manager/profileManager';
import { S2MapReview } from '../entity/S2MapReview';
import { S2MapReviewRevision } from '../entity/S2MapReviewRevision';
import { S2MapTrackingRepository } from '../repository/S2MapTrackingRepository';
import { S2Map } from '../entity/S2Map';

export class DataRecordPersistence extends ServiceProcess {
    protected queue: Queue<DataRecordType>;
    protected worker: Worker<DataRecordType>;
    protected scheduler: QueueScheduler;
    protected payloadHandlers = {
        [DataRecordKind.ProfileDiscover]: this.processProfileDiscover.bind(this),
        [DataRecordKind.MapReviews]: this.processMapReviews.bind(this),
    };

    constructor(public conn: orm.Connection) {
        super();
    }

    protected async doStart(): Promise<void> {
        this.queue = createDataRecordQueue();
        this.worker = createDataRecordWorker(this.process.bind(this), {
            concurrency: 1,
        });
        this.scheduler = createDataRecordScheduler();

        this.worker.on('active', (job: Job<DataRecordType>) => {
            logger.info(`[${job.data.dkind}] active "${job.name}" id: ${job.id}`);
        });

        this.worker.on('completed', (job: Job<DataRecordType>) => {
            logger.info(`[${job.data.dkind}] completed "${job.name}" id: ${job.id}`);
        });

        this.worker.on('failed', (job: Job<DataRecordType>) => {
            logger.warn(`[${job.data.dkind}] failed "${job.name}" id: ${job.id}`, job.stacktrace);
        });

        await this.periodicClean();
    }

    protected async doShutdown(): Promise<void> {
        await this.queue.close();
        await this.scheduler.close();
        await this.worker.pause(false);
        await this.worker.close(false);
        await this.worker.disconnect();
    }

    protected async periodicClean() {
        const jobCounts = await this.queue.getJobCounts('active', 'completed', 'failed', 'delayed', 'wait', 'paused');
        logger.info(`[${this.queue.name}] job counts - ${Object.entries(jobCounts).map(x => `${x[0]}: ${x[1]}`).join(' ')}`);
        await this.queue.clean(1000 * 60 * 15, 1000, 'completed');
        setTimeout(this.periodicClean.bind(this), 60000 * 5).unref();
    }

    protected async process(job: Job<DataRecordType>): Promise<void> {
        try {
            await this.payloadHandlers[job.data.dkind](job.data.payload as any);
        }
        catch (err) {
            logger.error(`failed during processing of "${job.name}" id: ${job.id}`, err);
            throw err;
        }
    }

    protected async processMapReviews(dp: MapReviews) {
        const reviewsUpdatedAt = new Date(dp.updatedAt * 1000);
        const mpTrack = await this.conn.getCustomRepository(S2MapTrackingRepository).fetchOrCreate({
            regionId: dp.regionId,
            mapId: dp.mapId,
        });
        if (
            (dp.newerThan > 0 && mpTrack.reviewsUpdatedPartiallyAt && mpTrack.reviewsUpdatedPartiallyAt > reviewsUpdatedAt) ||
            (dp.newerThan === 0 && mpTrack.reviewsUpdatedEntirelyAt && mpTrack.reviewsUpdatedEntirelyAt > reviewsUpdatedAt)
        ) {
            logger.verbose(oneLine`
                map reviews outdated, provided=${reviewsUpdatedAt.toISOString()}
                newerThan=${dp.newerThan}
                partially=${mpTrack.reviewsUpdatedPartiallyAt?.toISOString()}
                entirely=${mpTrack.reviewsUpdatedEntirelyAt?.toISOString()}
            `);
            return;
        }

        const qb = this.conn.getRepository(S2MapReview).createQueryBuilder('review')
            .andWhere('review.regionId = :regionId AND review.mapId = :mapId', {
                regionId: dp.regionId,
                mapId: dp.mapId,
            })
        ;
        if (dp.newerThan > 0 && dp.reviews.length > 0) {
            const authorLpIds = dp.reviews.map(x => x.authorLocalProfileId);
            qb.andWhere('review.authorLocalProfileId IN (:authorLpIds)', { authorLpIds: authorLpIds });
        }

        const storedReviews = await qb.getMany();
        if (dp.reviews.length === 0 && storedReviews.length > 0) {
            logger.warn(`expected non-zero reviews map=${dp.regionId}/${dp.mapId} stored len=${storedReviews.length}`);
            return;
        }

        const storedReviewsOfAuthor = new Map(storedReviews.map(x => [x.authorLocalProfileId, x]));
        const newReviews = dp.reviews.filter(x => !storedReviewsOfAuthor.has(x.authorLocalProfileId)).reverse();
        const updatedReviews = dp.reviews.filter(x => {
            const ritem = storedReviewsOfAuthor.get(x.authorLocalProfileId);
            return ritem && ritem.updatedAt.getTime() <= reviewsUpdatedAt.getTime() && (
                ritem.body !== x.body || ritem.rating !== x.rating
            );
        }).reverse();
        const updatedHelpfulOnly = dp.reviews.filter(x => {
            const ritem = storedReviewsOfAuthor.get(x.authorLocalProfileId);
            return ritem && ritem.updatedAt.getTime() <= reviewsUpdatedAt.getTime() && (
                ritem.body === x.body && ritem.rating === x.rating && ritem.helpfulCount !== x.helpfulCount
            );
        }).reverse();

        logger.verbose(oneLine`
            processing reviews map=${dp.regionId}/${dp.mapId}
            received=${dp.reviews.length} new=${newReviews.length} updated=${updatedReviews.length} updatedHelpful=${updatedHelpfulOnly.length}
        `);

        const s2NewReviews = newReviews.map(item => {
            const s2review = new S2MapReview();
            return Object.assign(new S2MapReview(), <S2MapReview>{
                regionId: dp.regionId,
                mapId: dp.mapId,
                authorLocalProfileId: item.authorLocalProfileId,
                createdAt: new Date(item.timestamp * 1000),
                updatedAt: new Date(item.timestamp * 1000),
                rating: item.rating,
                helpfulCount: item.helpfulCount,
                body: item.body,
                revisions: [
                    Object.assign(new S2MapReviewRevision(), <S2MapReviewRevision>{
                        date: new Date(dp.updatedAt * 1000),
                        rating: item.rating,
                        body: item.body,
                    })
                ],
            });
            return s2review;
        });

        await this.conn.transaction(async tsManager => {
            if (newReviews.length > 0) {
                await tsManager.getRepository(S2MapReview).insert(s2NewReviews);
                s2NewReviews.forEach(x => {
                    x.revisions[0].reviewId = x.id;
                });
                await tsManager.getRepository(S2MapReviewRevision).insert(s2NewReviews.map(x => x.revisions[0]));
            }

            if (updatedReviews.length > 0) {
                for (const item of updatedReviews) {
                    const s2review = storedReviewsOfAuthor.get(item.authorLocalProfileId);
                    await tsManager.getRepository(S2MapReview).update(s2review.id, {
                        helpfulCount: item.helpfulCount,
                        updatedAt: reviewsUpdatedAt,
                        rating: item.rating,
                        body: item.body,
                    });
                    await tsManager.getRepository(S2MapReviewRevision).insert({
                        reviewId: s2review.id,
                        date: reviewsUpdatedAt,
                        rating: item.rating,
                        body: item.body,
                    });
                }
            }

            if (updatedHelpfulOnly.length > 0) {
                for (const item of updatedHelpfulOnly) {
                    const s2review = storedReviewsOfAuthor.get(item.authorLocalProfileId);
                    await tsManager.getRepository(S2MapReview).update(s2review.id, {
                        helpfulCount: item.helpfulCount,
                    });
                }
            }

            if (dp.newerThan > 0) {
                await tsManager.getCustomRepository(S2MapTrackingRepository).update(
                    tsManager.getCustomRepository(S2MapTrackingRepository).getId(mpTrack),
                    {
                        reviewsUpdatedPartiallyAt: reviewsUpdatedAt,
                    }
                );
            }
            else {
                await tsManager.getCustomRepository(S2MapTrackingRepository).update(
                    tsManager.getCustomRepository(S2MapTrackingRepository).getId(mpTrack),
                    {
                        reviewsUpdatedEntirelyAt: reviewsUpdatedAt,
                    }
                );
            }

            if (newReviews.length > 0 || updatedReviews.length > 0) {
                const rsum: {
                    count: number;
                    avg: number;
                } = await tsManager.getRepository(S2MapReview).createQueryBuilder('review')
                    .select([])
                    .addSelect('COUNT(*)', 'count')
                    .addSelect('AVG(review.rating)', 'avg')
                    .andWhere('review.regionId = :regionId AND review.mapId = :mapId', {
                        regionId: dp.regionId,
                        mapId: dp.mapId,
                    })
                    .getRawOne()
                ;
                await tsManager.getRepository(S2Map).update(
                    {
                        regionId: dp.regionId,
                        bnetId: dp.mapId,
                    },
                    {
                        userReviewsCount: rsum.count,
                        userReviewsRating: rsum.avg,
                    }
                );
            }
        });
    }

    protected async processProfileDiscover(dp: ProfileDiscover) {
        const regionSet = new Set(dp.profiles.map(x => x.regionId));
        if (regionSet.size !== 1) {
            throw new Error(`exepected regionSet to have only one item. size=${regionSet.size} set=${regionSet}`);
        }
        const regionId = Array.from(regionSet)[0];
        const receivedProfiles = new Map(dp.profiles.map(x => [localProfileId(x), x]));

        const qb = this.conn.getRepository(S2Profile).createQueryBuilder('profile')
            .leftJoinAndMapOne(
                'profile.tracking',
                S2ProfileTracking,
                'pTrack',
                'profile.regionId = pTrack.regionId AND profile.localProfileId = pTrack.localProfileId'
            )
            .andWhere('profile.regionId = :regionId', { regionId: regionId })
            .andWhere('profile.localProfileId IN (:localProfileIds)', { localProfileIds: Array.from(receivedProfiles.keys()) })
        ;

        const storedProfiles = await qb.getMany();
        // logger.debug(`regionId=${regionId} receivedProfiles=${receivedProfiles.size} storedProfiles=${storedProfiles.length}`);

        const profileUpdates = new Map<number, { updatedProfile: Partial<S2Profile>; updatedTracking: Partial<S2ProfileTracking>; }>();
        const profileNew = new Map(receivedProfiles);

        for (const s2profile of storedProfiles) {
            profileNew.delete(s2profile.localProfileId);

            const newProfileData = receivedProfiles.get(s2profile.localProfileId);
            const updatedProfile: Partial<S2Profile> = {};
            const updatedTracking: Partial<S2ProfileTracking> = {};

            if (newProfileData.profileGameId !== null) {
                if (s2profile.profileGameId !== null && s2profile.profileGameId !== newProfileData.profileGameId) {
                    logger.error(`profileGameId not null and doesn't match prev value? new=${s2profile.profileGameId} prev=${newProfileData.profileGameId}`);
                    continue;
                }
                if (s2profile.profileGameId !== newProfileData.profileGameId) {
                    updatedProfile.profileGameId = newProfileData.profileGameId;
                }
            }

            if (s2profile.discriminator === 0) {
                if (newProfileData.characterHandle.indexOf('#') !== -1) {
                    const [ charName, charCode ] = newProfileData.characterHandle.split('#');
                    if (charName !== s2profile.name) {
                        logger.verbose(`new name "${newProfileData.characterHandle}" doesn't match old one "${s2profile.name}" for ${s2profile.fullnameWithHandle}`);
                        updatedProfile.name = charName;
                    }
                    updatedProfile.discriminator = Number(charCode);
                    updatedTracking.nameUpdatedAt = new Date();
                }
            }

            if (newProfileData.battleHandle !== null) {
                if (s2profile.battleTag !== null && s2profile.battleTag !== newProfileData.battleHandle) {
                    logger.info(`new battletag=${newProfileData.battleHandle} prev=${s2profile.battleTag} for ${s2profile.fullnameWithHandle}`);
                }
                if (s2profile.battleTag !== newProfileData.battleHandle) {
                    updatedProfile.battleTag = newProfileData.battleHandle;
                }
            }

            if (Object.keys(updatedProfile).length > 0 || Object.keys(updatedTracking).length > 0) {
                profileUpdates.set(s2profile.localProfileId, {
                    updatedProfile: updatedProfile,
                    updatedTracking: updatedTracking,
                });
            }
        }

        logger.debug(`regionId=${regionId} profileUpdates=${profileUpdates.size} profileNew=${profileNew.size}`);

        if (profileUpdates.size > 0) {
            await this.conn.transaction(async tsManager => {
                for (const [lprofId, item] of profileUpdates) {
                    if (Object.keys(item.updatedProfile).length) {
                        await tsManager.getRepository(S2Profile).update({
                            regionId: regionId,
                            localProfileId: lprofId,
                        }, item.updatedProfile);
                    }
                    if (Object.keys(item.updatedTracking).length) {
                        await tsManager.getRepository(S2ProfileTracking).update({
                            regionId: regionId,
                            localProfileId: lprofId,
                        }, item.updatedTracking);
                    }
                }
            });
        }

        for (const [lprofId, profileData] of profileNew) {
            let charName: string = '';
            let charCode: string = '0';
            if (profileData.characterHandle.indexOf('#') !== -1) {
                [ charName, charCode ] = profileData.characterHandle.split('#');
            }
            const s2profile = await ProfileManager.create({
                regionId: profileData.regionId,
                realmId: profileData.realmId,
                profileId: profileData.profileId,
                name: charName,
                discriminator: Number(charCode),
                profileGameId: profileData.profileGameId,
                battleTag: profileData.battleHandle,
                deleted: charName === '',
                lastOnlineAt: profileData.battleHandle !== null ? new Date(Date.now() - 1000 * 3600 * 24) : null
            }, this.conn);
            logger.verbose(`created profile ${s2profile.fullnameWithHandle}`);
        }
    }
}
