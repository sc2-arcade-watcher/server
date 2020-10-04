import fastify from 'fastify';
import * as fastifyOAS from 'fastify-oas';

declare module 'fastify' {
    interface FastifySchema {
        /**
        * Hides route from result OpenAPI document
        * @default false
        */
        hide?: boolean;
        /**
        * Route description
        */
        description?: string;
        /**
        * Route summary
        */
        summary?: string;
        /**
        * Route tags
        */
        tags?: Array<string>;
        /**
        * Media types route consumes
        */
        consumes?: Array<string>;
        /**
        * Media types route produces
        */
        produces?: Array<string>;
        /**
        * OpenAPI security definitions
        */
        // security?: Array<SecurityRequirementObject>;
        /**
        * OpenAPI operation unique identifier
        */
        operationId?: string;
    }
}
