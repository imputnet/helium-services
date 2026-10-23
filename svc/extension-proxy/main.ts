import { serve } from '@hono/node-server';
import { respondWithError } from '@helium-services/common/http';

import * as Handlers from './lib/handlers.ts';

const handleRequest = async (request: Request) => {
    try {
        return await Handlers.handle(request);
    } catch (e) {
        return respondWithError(
            e,
            (status, text) => `error ${status}: ${text}`,
        );
    }
};

if (import.meta.main) {
    serve({ fetch: handleRequest, port: 8000 });
}
