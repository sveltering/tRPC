import type { PageLoad } from './$types';
import { loadClient } from '../trpc/loadClient';

export const load = (async (event) => {
	let data;
	try {
		data = await loadClient(event).hello.query();
	} catch (e) {
		data = 'error';
	}

	return { data };
}) satisfies PageLoad;
