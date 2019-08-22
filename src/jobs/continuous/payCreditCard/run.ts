/**
 * クレジットカード支払
 */
import * as ttts from '@tokyotower/domain';
import * as createDebug from 'debug';

import { connectMongo } from '../../../connectMongo';

const debug = createDebug('cinerino-api');

export default async (_: {
    project?: ttts.factory.project.IProject;
}) => {
    const connection = await connectMongo({ defaultConnection: false });
    const redisClient = ttts.redis.createClient(
        {
            host: <string>process.env.REDIS_HOST,
            port: Number(<string>process.env.REDIS_PORT),
            password: <string>process.env.REDIS_KEY,
            tls: { servername: <string>process.env.REDIS_HOST }
        }
    );

    let count = 0;

    const MAX_NUBMER_OF_PARALLEL_TASKS = 10;
    const INTERVAL_MILLISECONDS = 1000;

    setInterval(
        async () => {
            if (count > MAX_NUBMER_OF_PARALLEL_TASKS) {
                return;
            }

            count += 1;

            try {
                debug('count:', count);
                await ttts.service.task.executeByName({
                    name: <any>ttts.factory.cinerino.taskName.PayCreditCard
                })({
                    connection: connection,
                    redisClient: redisClient
                });
            } catch (error) {
                // tslint:disable-next-line:no-console
                console.error(error);
            }

            count -= 1;
        },
        INTERVAL_MILLISECONDS
    );
};