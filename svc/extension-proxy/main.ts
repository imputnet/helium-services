import * as Util from './lib/util.ts';
import * as Handlers from './lib/handlers.ts';

export default {
    async fetch(request: Request) {
        try {
            return await Handlers.handle(request);
        } catch (e) {
            return Util.respondWithError(e);
        }
    },
};
