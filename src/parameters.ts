// number of seconds before an invalid result expires
export const EXPIRE_INVALID_SEC: number = 60 * 60 * 24;

// number of expired cache entries to re-fetch per hour
export const REFETCH_PER_HOUR: number = 10;

// time (in ms) we delay queries to the nexus api to see if we can batch multiple queries
// in one request
export const BATCHED_REQUEST_TIME: number = 500;
