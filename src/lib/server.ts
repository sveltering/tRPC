// Reexport your entry components here
import type { RequestEvent } from '@sveltejs/kit';
import { initTRPC, TRPCError, type AnyRouter } from '@trpc/server';
import { resolveHTTPResponse } from '@trpc/server/http';
import type { HTTPResponse } from '@trpc/server/dist/http/internals/types';
import type { HTTPHeaders } from '@trpc/client';
import { parse as parseURL } from 'url';

type keyValueType = { [key: string]: any };
type pipeType = false | keyValueType;

type ArgumentTypes<F extends Function> = F extends (...args: infer A) => any ? A : never;
type SyncReturnType<T extends Function> = T extends (...args: any) => infer R ? R : any;
type createContextType<T> = (event?: RequestEvent, pipe?: pipeType) => Promise<T> | T;

type TRPCErrorOpts = ConstructorParameters<typeof TRPCError>[0];

interface TRPCOptions_I<T> {
	path: string;
	origin?: string;
	bypassOrigin?: string;
	context?: createContextType<T>;
	beforeResolve?: (event: RequestEvent, pipe: pipeType) => any;
	resolveError?: (event: RequestEvent, pipe: pipeType) => any;
	beforeResponse?: (event: RequestEvent, pipe: pipeType, result: HTTPResponse) => any;
	resolveOptions?: ArgumentTypes<typeof resolveHTTPResponse>[0];
	createOptions?: ArgumentTypes<typeof initTRPC.create>[0];
	locals?: 'always' | 'callable' | 'never';
	localsKey?: string;
}

interface TRPCOptionsFinal_I<T> {
	context: createContextType<T>;
}

export class TRPC<T extends object> {
	//OPTIONS
	options: TRPCOptions_I<T> & TRPCOptionsFinal_I<T>;
	//OTHER
	tRPCInner: SyncReturnType<SyncReturnType<typeof initTRPC.context<T>>['create']>;
	_routes?: AnyRouter;
	constructor(options: TRPCOptions_I<T>) {
		if (typeof window !== 'undefined') {
			throw new Error('new TRPC() should only be used within the server environment.');
		}
		this.options = {
			context: () => ({} as any),
			locals: 'never',
			localsKey: 'TRPC',
			...options
		};
		this.tRPCInner = initTRPC.context<T>().create(this.options?.createOptions || {});
		return this;
	}

	get router() {
		return this.tRPCInner.router;
	}
	get middleware() {
		return this.tRPCInner.middleware;
	}
	get procedure() {
		return this.tRPCInner.procedure;
	}

	get context() {
		return this?.options?.context;
	}

	error(message: string | TRPCErrorOpts, code?: TRPCErrorOpts['code']) {
		return new TRPCError(
			typeof message === 'string'
				? {
						code: code || 'BAD_REQUEST',
						message
				  }
				: message
		);
	}

	set routes(routes: AnyRouter) {
		this._routes = routes;
	}

	hook(router: AnyRouter) {
		this._routes = router;
		const options = this.options;
		return async function (event: RequestEvent): Promise<false | Response> {
			const pipe: keyValueType = {};
			const localsKey = options.localsKey;
			const contextFnConsturctor = options.context.constructor.name;

			const URL = event.url;
			const pathName = URL.pathname;

			if (!pathName.startsWith(options.path)) {
				if (options.locals === 'always') {
					if (contextFnConsturctor === 'AsyncFunction') {
						//@ts-ignore
						event.locals[localsKey] = router.createCaller(await options.context(event, false));
					} else if (contextFnConsturctor === 'Function') {
						//@ts-ignore
						event.locals[localsKey] = router.createCaller(options.context(event, false));
					}
				} //
				else if (options.locals === 'callable') {
					if (contextFnConsturctor === 'AsyncFunction') {
						//@ts-ignore
						event.locals[localsKey] = async () =>
							router.createCaller(await options.context(event, false));
					} else if (contextFnConsturctor === 'Function') {
						//@ts-ignore
						event.locals[localsKey] = () => router.createCaller(options.context(event, false));
					}
				}
				return false;
			}
			const request = event.request as Request;

			let result;

			if (options?.beforeResolve) {
				await options.beforeResolve?.(event, pipe);
			}

			if (options?.resolveError) {
				const errorMessage = await options.resolveError?.(event, pipe);
				if (errorMessage) {
					const path = parseURL(request.url)
						.pathname?.substring?.(options.path.length + 1)
						?.replaceAll?.('/', '.');
					result = {
						body: `[{"error":{"message":"${errorMessage}","code":-32600,"data":{"code":"BAD_REQUEST","httpStatus":400,"path":"${path}"}}}]`,
						status: 400,
						headers: { 'Content-Type': 'application/json' }
					};
				}
			}

			if (!result) {
				result = await resolveHTTPResponse({
					createContext: async () => await options.context(event, pipe),
					path: pathName.substring(options.path.length + 1),
					req: {
						body: await request.text(),
						headers: request.headers as unknown as HTTPHeaders,
						method: request.method,
						query: URL.searchParams
					},
					router,
					...options?.resolveOptions
				});
			}

			if (!result?.headers) {
				result.headers = {};
			}

			if (options?.beforeResponse) {
				await options?.beforeResponse(event, pipe, result);
			}

			return new Response(result.body, {
				headers: result.headers as HeadersInit,
				status: result.status
			});
		};
	}

	handleFetch() {
		const options = this.options;
		if (!options?.origin || !options?.bypassOrigin) {
			throw new Error(
				`Message from \`handleFetch()\`
No origin or bypass origin has been set, are you sure you need to handle fetch?`
			);
		}
		return function (request: Request) {
			if (request.url.startsWith(options.origin as string)) {
				return new Request(
					options.bypassOrigin + request.url.substring((options.origin as string).length),
					request
				);
			}
			return request;
		};
	}
}

type functionType = (...args: any) => any;

export const asyncServerClientCreate = function <R extends AnyRouter>(
	t: TRPC<any>
): (event: RequestEvent) => Promise<ReturnType<R['createCaller']>> {
	if (console?.warn && t.context.constructor.name === 'Function') {
		console.warn(
			`Message from \`asyncServerClientCreate()\`
Your context function is synchronous. Either:
	1. Switch to \`syncServerClientCreate()\` if you have synchronous code in your context function
	OR
	2. Change your context function to async if you have asynchronous code in the context function`
		);
	}

	if (!t?._routes) {
		throw new Error(
			`You must set your final routes.
This is achieved by either
1. Creating hooks with \`t.hooks(routes)\`
OR
2. Setting it on the TRPC object using \`t.routes = routes\``
		);
	}

	return async function (event: RequestEvent): Promise<ReturnType<R['createCaller']>> {
		return t?._routes?.createCaller?.(await t.context(event, false)) as ReturnType<
			R['createCaller']
		>;
	};
};

export const syncServerClientCreate = function <R extends AnyRouter>(
	t: TRPC<any>
): (event: RequestEvent) => ReturnType<R['createCaller']> {
	if (console?.warn && t.context.constructor.name === 'AsyncFunction') {
		console.warn(
			`Message from \`syncServerClientCreate()\`
	Your context function is asynchronous. Either:
		1. Switch to \`asyncServerClientCreate()\` if you have asynchronous code in your context function
		OR
		2. Change your context function to a regular sync function if you have synchronous code in the context function`
		);
	}

	return function (event: RequestEvent): ReturnType<R['createCaller']> {
		return t?._routes?.createCaller(t.context(event, false)) as ReturnType<R['createCaller']>;
	};
};