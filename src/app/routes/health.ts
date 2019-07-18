/**
 * ヘルスチェックルーター
 */
import * as ttts from '@tokyotower/domain';
import * as express from 'express';

const healthRouter = express.Router();

import * as createDebug from 'debug';
import { OK } from 'http-status';

const redisClient = ttts.redis.createClient({
    host: <string>process.env.REDIS_HOST,
    // tslint:disable-next-line:no-magic-numbers
    port: parseInt(<string>process.env.REDIS_PORT, 10),
    password: <string>process.env.REDIS_KEY,
    tls: { servername: <string>process.env.REDIS_HOST }
});

const debug = createDebug('cinerino-api:router');
// 接続確認をあきらめる時間(ミリ秒)
const TIMEOUT_GIVE_UP_CHECKING_IN_MILLISECONDS = 3000;

healthRouter.get(
    '',
    async (_, res, next) => {
        try {
            await ttts.mongoose.connection.db.admin()
                .ping();
            await new Promise(async (resolve, reject) => {
                let givenUpChecking = false;

                // redisサーバー接続が生きているかどうか確認
                redisClient
                    .ping('wake up!', (err, reply) => {
                        debug('redis ping:', err, reply);
                        // すでにあきらめていたら何もしない
                        if (givenUpChecking) {
                            return;
                        }

                        if (err instanceof Error) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });

                setTimeout(
                    () => {
                        givenUpChecking = true;
                        reject(new Error('unable to check db connection'));
                    },
                    TIMEOUT_GIVE_UP_CHECKING_IN_MILLISECONDS
                );
            });

            res.status(OK)
                .send('healthy!');
        } catch (error) {
            next(error);
        }
    });

export default healthRouter;
