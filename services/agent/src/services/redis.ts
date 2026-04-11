import Redis from 'ioredis';

let redis: Redis;

export const initRedis = (url: string) => {
  redis = new Redis(url);
  redis.on('error', (err) => console.error('Redis error:', err));
  console.log('Redis connected');
};

export const setPrice = async (token: string, priceData: any, ttl = 30) => {
  if (!redis) return;
  await redis.setex(`price:${token.toLowerCase()}`, ttl, JSON.stringify(priceData));
};

export const getPrice = async (token: string) => {
  if (!redis) return null;
  const data = await redis.get(`price:${token.toLowerCase()}`);
  return data ? JSON.parse(data) : null;
};

export { redis };
