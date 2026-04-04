import { HTTPStatus } from '../rfc/7231.ts';
export { HTTPStatus as status } from '../rfc/7231.ts';

export const checkMethod = (req: Request, ...allowedMethods: string[]) => {
    if (!allowedMethods.includes(req.method)) {
        return new Response(
            null,
            {
                status: HTTPStatus.METHOD_NOT_ALLOWED,
                headers: { Allow: allowedMethods.join(', ') },
            },
        );
    }
};

export * from './request.ts';
