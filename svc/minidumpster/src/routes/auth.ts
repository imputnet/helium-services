import { Hono, type MiddlewareHandler } from 'hono';
import { githubAuth } from '@hono/oauth-providers/github';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';

import * as ui from '../ui.ts';
import { logEvent } from '../log.ts';
import type { Config } from '../config.ts';
import type { AppDeps, Env } from '../app.ts';
import { checkOrgMembership } from '../github.ts';
import { decodeSession, encodeSession } from '../session.ts';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function authRoutes(deps: AppDeps): Hono<Env> {
    const { config } = deps;
    const ghFetch = deps.githubFetch ?? fetch;
    const secureCookies = config.publicBaseUrl.startsWith('https://');
    const cookieOpts = {
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'Lax',
        path: '/',
    } as const;

    const app = new Hono<Env>();

    app.get('/auth/login', (c) => c.redirect('/auth/callback'));
    app.use(
        '/auth/callback',
        githubAuth({
            client_id: config.githubClientId,
            client_secret: config.githubClientSecret,
            // user:email because the middleware always fetches /user/emails
            scope: ['read:org', 'user:email'],
            oauthApp: true,
        }) as unknown as MiddlewareHandler<Env>,
    );

    app.get('/auth/callback', async (c) => {
        const token = c.get('token');
        const user = c.get('user-github');
        if (!token?.token || !user?.login) {
            return c.html(
                ui.messagePage('Login failed', 'GitHub did not return a user.'),
                502,
            );
        }

        if (
            !await checkOrgMembership(
                ghFetch,
                token.token,
                config.githubOrg,
            )
        ) {
            logEvent('login_denied', {
                login: user.login,
                org: config.githubOrg,
            });
            return c.html(
                ui.messagePage(
                    'Access denied',
                    `@${user.login} is not an active member of the ${config.githubOrg} GitHub org.`,
                ),
                403,
            );
        }

        await setSignedCookie(
            c,
            'session',
            encodeSession({
                login: user.login,
                exp: Date.now() + SESSION_TTL_MS,
            }),
            config.sessionSecret,
            { ...cookieOpts, maxAge: SESSION_TTL_MS / 1000 },
        );

        logEvent('login_ok', { login: user.login });
        return c.redirect('/');
    });

    app.get('/auth/logout', (c) => {
        deleteCookie(c, 'session', { path: '/' });
        return c.redirect('/auth/login');
    });

    return app;
}

export function requireSession(config: Config): MiddlewareHandler<Env> {
    return async (c, next) => {
        const raw = await getSignedCookie(c, config.sessionSecret, 'session');
        const session = decodeSession(raw);
        if (!session) {
            return c.redirect('/auth/login');
        }

        c.set('session', session);
        await next();
    };
}
