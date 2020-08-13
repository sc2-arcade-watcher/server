import * as http from 'http';
import * as fastify from 'fastify';
import * as fp from 'fastify-plugin';
import { atob, btoa } from '../helpers';

export interface CursorPaginationQuery {
    before: {[k: string]: string} | undefined;
    after: {[k: string]: string} | undefined;
    limit: number;
    fetchLimit: number;
    getOrderDirection: (order?: 'ASC' | 'DESC') => 'ASC' | 'DESC';
    paginationKeys?: string[];
}

export interface CursorPaginationInfo {
    prev: string | null;
    next: string | null;
}

export interface CursorPaginationResponse<T> {
    page: CursorPaginationInfo;
    results: T[];
}

declare module 'fastify' {
    interface FastifyRequest {
        parseCursorPagination(this: fastify.FastifyRequest, opts?: { paginationKeys?: string[]; }): CursorPaginationQuery;
    }

    interface FastifyReply<HttpResponse> {
        sendWithCursorPagination<T>(this: fastify.FastifyReply<http.ServerResponse>, results: T[], pQuery: CursorPaginationQuery): CursorPaginationResponse<T>;
    }
}

const defaultLimit = 50;
const maximumLimit = 500;

export default fp(async (server, opts, next) => {
    server.decorateRequest('parseCursorPagination', function (this: fastify.FastifyRequest, opts?: { paginationKeys?: string[]; }) {
        let limit = parseInt(this.query.limit);
        if (Number.isNaN(limit)) {
            limit = defaultLimit;
        }
        else {
            limit = Math.min(maximumLimit, Math.max(limit, 1));
        }

        const pq: CursorPaginationQuery = {
            limit: limit,
            fetchLimit: limit + 1,
            paginationKeys: opts?.paginationKeys ?? ['id'],
        } as CursorPaginationQuery;

        function decodeKeyValues(value: string) {
            if (!value) return void 0;
            const kvals = JSON.parse(atob(value));
            if (!Array.isArray(kvals)) return void 0;
            const kvmap: {[k: string]: string} = {};
            for (const k of pq.paginationKeys) {
                kvmap[k] = kvals.length ? kvals.shift() : '';
            }
            return kvmap;
        }

        pq.before = decodeKeyValues(this.query.before);
        pq.after = decodeKeyValues(this.query.after);

        pq.getOrderDirection = (order?) => {
            if (!order) order = 'ASC';
            if (pq.before && order === 'ASC') return 'DESC';
            if (pq.before && order === 'DESC') return 'ASC';
            return order;
        };

        return pq;
    });

    server.decorateReply('sendWithCursorPagination', function<T> (this: fastify.FastifyReply<http.ServerResponse>, results: T[], pQuery: CursorPaginationQuery) {
        function encodeKeyValues(entry: T) {
            const kvals: string[] = [];
            for (const k of pQuery.paginationKeys) {
                let tmpval: string | any = entry;
                for (const ksub of k.split('.')) {
                    tmpval = (<any>tmpval)[ksub];
                    if (tmpval === void 0 || tmpval === null) {
                        tmpval = '';
                        break;
                    }
                }
                kvals.push(tmpval);
            }
            return btoa(JSON.stringify(kvals));
        }

        const presponse: CursorPaginationResponse<T> = {
            page: {
                prev: null,
                next: null,
            },
            results,
        };
        if (pQuery.before) {
            if (results.length) {
                presponse.page.next = encodeKeyValues(results[0]);
            }
            if (results.length > pQuery.limit) {
                presponse.page.prev = encodeKeyValues(results[pQuery.limit - 1]);
                presponse.results = results.slice(0, pQuery.limit).reverse();
            }
        }
        else {
            if (pQuery.after) {
                if (results.length) {
                    presponse.page.prev = encodeKeyValues(results[0]);
                }
            }
            if (results.length > pQuery.limit) {
                presponse.page.next = encodeKeyValues(results[pQuery.limit - 1]);
                presponse.results = results.slice(0, pQuery.limit);
            }
        }
        return presponse;
    });
});
