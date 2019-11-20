/**
 * 注文取引ルーター(POS専用)
 */
import * as cinerinoapi from '@cinerino/api-nodejs-client';
import * as ttts from '@tokyotower/domain';
import { Router } from 'express';
import { CREATED, NO_CONTENT } from 'http-status';
import * as moment from 'moment-timezone';
import * as request from 'request-promise-native';

const auth = new cinerinoapi.auth.ClientCredentials({
    domain: '',
    clientId: '',
    clientSecret: '',
    scopes: [],
    state: ''
});

const placeOrderTransactionsRouter = Router();

import authentication from '../../middlewares/authentication';
import permitScopes from '../../middlewares/permitScopes';
import validator from '../../middlewares/validator';

const TRANSACTION_TTL = 3600;
const TRANSACTION_KEY_PREFIX = 'ttts-api:placeOrder:';
const TRANSACTION_AGENT_TTL = TRANSACTION_TTL;
const TRANSACTION_AGENT_KEY_PREFIX = `${TRANSACTION_KEY_PREFIX}agent:`;
const TRANSACTION_AMOUNT_TTL = TRANSACTION_TTL;
const TRANSACTION_AMOUNT_KEY_PREFIX = `${TRANSACTION_KEY_PREFIX}amount:`;
const AUTHORIZE_SEAT_RESERVATION_RESULT_TTL = TRANSACTION_TTL;
const AUTHORIZE_SEAT_RESERVATION_RESULT_KEY_PREFIX = `${TRANSACTION_KEY_PREFIX}authorizeSeatReservationResult:`;
const CUSTOMER_PROFILE_TTL = TRANSACTION_TTL;
const CUSTOMER_PROFILE_KEY_PREFIX = `${TRANSACTION_KEY_PREFIX}customerProfile:`;

const ORDERS_TTL = 86400;
export const ORDERS_KEY_PREFIX = 'ttts-api:orders:';

const redisClient = ttts.redis.createClient({
    host: <string>process.env.REDIS_HOST,
    port: Number(<string>process.env.REDIS_PORT),
    password: <string>process.env.REDIS_KEY,
    tls: { servername: <string>process.env.REDIS_HOST }
});

placeOrderTransactionsRouter.use(authentication);

placeOrderTransactionsRouter.post(
    '/start',
    permitScopes(['pos']),
    (req, _, next) => {
        req.checkBody('expires')
            .notEmpty()
            .withMessage('required')
            .isISO8601();

        next();
    },
    validator,
    async (req, res, next) => {
        try {
            auth.setCredentials({ access_token: req.accessToken });
            const placeOrderService = new cinerinoapi.service.transaction.PlaceOrder4ttts({
                auth: auth,
                endpoint: <string>process.env.CINERINO_API_ENDPOINT
            });
            const sellerService = new cinerinoapi.service.Seller({
                auth: auth,
                endpoint: <string>process.env.CINERINO_API_ENDPOINT
            });

            const searchSellersResult = await sellerService.search({
                limit: 1
            });
            const seller = searchSellersResult.data.shift();
            if (seller === undefined) {
                throw new Error('Seller not found');
            }

            // WAITER許可証を取得
            const scope = 'placeOrderTransaction.TokyoTower.POS';
            const { token } = await request.post(
                `${process.env.WAITER_ENDPOINT}/projects/${<string>process.env.PROJECT_ID}/passports`,
                {
                    json: true,
                    body: { scope: scope }
                }
            )
                .then((body) => body);

            const expires = moment(req.body.expires)
                .toDate();

            const transaction = await placeOrderService.start({
                expires: expires,
                object: {
                    passport: { token }
                },
                seller: {
                    typeOf: seller.typeOf,
                    id: seller.id
                }
            });

            // 取引エージェント保管
            const transactionAgentKey = `${TRANSACTION_AGENT_KEY_PREFIX}${transaction.id}`;
            await new Promise((resolve, reject) => {
                redisClient.multi()
                    .set(transactionAgentKey, JSON.stringify(transaction.agent))
                    .expire(transactionAgentKey, TRANSACTION_AGENT_TTL)
                    .exec((err) => {
                        if (err !== null) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
            });

            // tslint:disable-next-line:no-string-literal
            // const host = req.headers['host'];
            // res.setHeader('Location', `https://${host}/transactions/${transaction.id}`);
            res.status(CREATED)
                .json(transaction);
        } catch (error) {
            next(error);
        }
    }
);

/**
 * 購入者情報を変更する
 */
placeOrderTransactionsRouter.put(
    '/:transactionId/customerContact',
    permitScopes(['pos']),
    (req, _, next) => {
        req.checkBody('last_name')
            .notEmpty()
            .withMessage('required');
        req.checkBody('first_name')
            .notEmpty()
            .withMessage('required');
        req.checkBody('tel')
            .notEmpty()
            .withMessage('required');
        req.checkBody('email')
            .notEmpty()
            .withMessage('required');

        next();
    },
    validator,
    async (req, res, next) => {
        try {
            auth.setCredentials({ access_token: req.accessToken });
            const placeOrderService = new cinerinoapi.service.transaction.PlaceOrder4ttts({
                auth: auth,
                endpoint: <string>process.env.CINERINO_API_ENDPOINT
            });

            const profile = await placeOrderService.setCustomerContact({
                id: req.params.transactionId,
                object: {
                    customerContact: {
                        ...req.body,
                        id: req.user.sub,
                        givenName: (typeof req.body.first_name === 'string') ? req.body.first_name : '',
                        familyName: (typeof req.body.last_name === 'string') ? req.body.last_name : '',
                        telephone: (typeof req.body.tel === 'string') ? req.body.tel : '',
                        telephoneRegion: (typeof req.body.address === 'string') ? req.body.address : ''
                    }
                }
            });

            // プロフィール保管
            const customerProfileKey = `${CUSTOMER_PROFILE_KEY_PREFIX}${req.params.transactionId}`;
            await new Promise((resolve, reject) => {
                redisClient.multi()
                    .set(customerProfileKey, JSON.stringify(profile))
                    .expire(customerProfileKey, CUSTOMER_PROFILE_TTL)
                    .exec((err) => {
                        if (err !== null) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
            });

            res.status(CREATED)
                .json({
                    ...profile,
                    // POSへの互換性維持のために値補完
                    last_name: profile.familyName,
                    first_name: profile.givenName,
                    tel: profile.telephone
                });
        } catch (error) {
            next(error);
        }
    }
);

/**
 * 座席仮予約
 */
placeOrderTransactionsRouter.post(
    '/:transactionId/actions/authorize/seatReservation',
    permitScopes(['pos']),
    validator,
    async (req, res, next) => {
        try {
            if (!Array.isArray(req.body.offers)) {
                req.body.offers = [];
            }

            const performanceId: string = req.body.performance_id;

            auth.setCredentials({ access_token: req.accessToken });
            const placeOrderService = new cinerinoapi.service.transaction.PlaceOrder4ttts({
                auth: auth,
                endpoint: <string>process.env.CINERINO_API_ENDPOINT
            });

            const action = await placeOrderService.createSeatReservationAuthorization({
                transactionId: req.params.transactionId,
                performanceId: performanceId,
                offers: req.body.offers
            });

            if (action.result !== undefined) {
                // 金額保管
                const amountKey = `${TRANSACTION_AMOUNT_KEY_PREFIX}${req.params.transactionId}`;
                const amount = action.result.price;
                await new Promise((resolve, reject) => {
                    redisClient.multi()
                        .set(amountKey, amount.toString())
                        .expire(amountKey, TRANSACTION_AMOUNT_TTL)
                        .exec((err) => {
                            if (err !== null) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                });

                // 承認結果保管
                const authorizeSeatReservationResultKey = `${AUTHORIZE_SEAT_RESERVATION_RESULT_KEY_PREFIX}${req.params.transactionId}`;
                await new Promise((resolve, reject) => {
                    redisClient.multi()
                        .set(authorizeSeatReservationResultKey, JSON.stringify(action.result))
                        .expire(authorizeSeatReservationResultKey, AUTHORIZE_SEAT_RESERVATION_RESULT_TTL)
                        .exec((err) => {
                            if (err !== null) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                });
            }

            res.status(CREATED)
                .json(action);
        } catch (error) {
            next(error);
        }
    }
);

/**
 * 座席仮予約削除
 */
placeOrderTransactionsRouter.delete(
    '/:transactionId/actions/authorize/seatReservation/:actionId',
    permitScopes(['pos']),
    validator,
    async (req, res, next) => {
        try {
            auth.setCredentials({ access_token: req.accessToken });
            const placeOrderService = new cinerinoapi.service.transaction.PlaceOrder4ttts({
                auth: auth,
                endpoint: <string>process.env.CINERINO_API_ENDPOINT
            });

            await placeOrderService.cancelSeatReservationAuthorization({
                transactionId: req.params.transactionId,
                actionId: req.params.actionId
            });

            // 金額リセット
            const amountKey = `${TRANSACTION_AMOUNT_KEY_PREFIX}${req.params.transactionId}`;
            await new Promise((resolve, reject) => {
                redisClient.multi()
                    .set(amountKey, '0')
                    .expire(amountKey, TRANSACTION_AMOUNT_TTL)
                    .exec((err) => {
                        if (err !== null) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
            });

            // 座席予約承認結果リセット
            const authorizeSeatReservationResultKey = `${AUTHORIZE_SEAT_RESERVATION_RESULT_KEY_PREFIX}${req.params.transactionId}`;
            await new Promise((resolve, reject) => {
                redisClient.multi()
                    .del(authorizeSeatReservationResultKey)
                    .exec((err) => {
                        if (err !== null) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
            });

            res.status(NO_CONTENT)
                .end();
        } catch (error) {
            next(error);
        }
    }
);

placeOrderTransactionsRouter.post(
    '/:transactionId/confirm',
    permitScopes(['pos']),
    validator,
    // tslint:disable-next-line:max-func-body-length
    async (req, res, next) => {
        try {
            // クライアントがPOSの場合、決済方法承認アクションを自動生成
            auth.setCredentials({ access_token: req.accessToken });
            const paymentService = new cinerinoapi.service.Payment({
                auth: auth,
                endpoint: <string>process.env.CINERINO_API_ENDPOINT
            });

            // 金額取得
            const amountKey = `${TRANSACTION_AMOUNT_KEY_PREFIX}${req.params.transactionId}`;
            const amount = await new Promise<number>((resolve, reject) => {
                redisClient.get(amountKey, (err, reply) => {
                    if (err !== null) {
                        reject(err);
                    } else {
                        resolve(Number(reply));
                    }
                });
            });

            // 取引エージェント取得
            const transactionAgentKey = `${TRANSACTION_AGENT_KEY_PREFIX}${req.params.transactionId}`;
            const transactionAgent = await new Promise<any>((resolve, reject) => {
                redisClient.get(transactionAgentKey, (err, reply) => {
                    if (err !== null) {
                        reject(err);
                    } else {
                        resolve(JSON.parse(reply));
                    }
                });
            });

            // 購入者プロフィール取得
            const customerProfileKey = `${CUSTOMER_PROFILE_KEY_PREFIX}${req.params.transactionId}`;
            const customerProfile = await new Promise<any>((resolve, reject) => {
                redisClient.get(customerProfileKey, (err, reply) => {
                    if (err !== null) {
                        reject(err);
                    } else {
                        resolve(JSON.parse(reply));
                    }
                });
            });

            // 座席予約承認結果取得
            const authorizeSeatReservationResultKey = `${AUTHORIZE_SEAT_RESERVATION_RESULT_KEY_PREFIX}${req.params.transactionId}`;
            const authorizeSeatReservationResult = await new Promise<any>((resolve, reject) => {
                redisClient.get(authorizeSeatReservationResultKey, (err, reply) => {
                    if (err !== null) {
                        reject(err);
                    } else {
                        resolve(JSON.parse(reply));
                    }
                });
            });

            await paymentService.authorizeAnyPayment({
                object: {
                    typeOf: cinerinoapi.factory.paymentMethodType.Cash,
                    name: cinerinoapi.factory.paymentMethodType.Cash,
                    additionalProperty: [],
                    amount: amount
                },
                purpose: { typeOf: cinerinoapi.factory.transactionType.PlaceOrder, id: req.params.transactionId }
            });

            const placeOrderService = new cinerinoapi.service.transaction.PlaceOrder4ttts({
                auth: auth,
                endpoint: <string>process.env.CINERINO_API_ENDPOINT
            });

            // 購入番号発行
            const paymentNoRepo = new ttts.repository.PaymentNo(redisClient);
            const reserveTransaction = authorizeSeatReservationResult.responseBody;
            if (reserveTransaction === undefined) {
                throw new cinerinoapi.factory.errors.Argument('Transaction', 'Reserve trasaction required');
            }
            const event = reserveTransaction.object.reservationFor;
            if (event === undefined || event === null) {
                throw new cinerinoapi.factory.errors.Argument('Transaction', 'Event required');
            }
            const eventStartDateStr = moment(event.startDate)
                .tz('Asia/Tokyo')
                .format('YYYYMMDD');
            const paymentNo = await paymentNoRepo.publish(eventStartDateStr);

            const { potentialActions, result } = createPotentialActions({
                transactionId: req.params.transactionId,
                authorizeSeatReservationResult: authorizeSeatReservationResult,
                customer: transactionAgent,
                profile: customerProfile,
                paymentMethodName: cinerinoapi.factory.paymentMethodType.Cash,
                paymentNo: paymentNo
            });

            const transactionResult = await placeOrderService.confirm({
                id: req.params.transactionId,
                potentialActions: potentialActions,
                result: result
            });

            // 返品できるようにしばし注文情報を保管
            const orderKey = `${ORDERS_KEY_PREFIX}${eventStartDateStr}${paymentNo}`;
            await new Promise((resolve, reject) => {
                redisClient.multi()
                    .set(orderKey, JSON.stringify(transactionResult.order))
                    .expire(orderKey, ORDERS_TTL)
                    .exec((err) => {
                        if (err !== null) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
            });

            res.status(CREATED)
                .json({
                    ...transactionResult,
                    // POSへ互換性維持のためにeventReservations属性を生成
                    eventReservations: (transactionResult !== undefined)
                        ? transactionResult.order.acceptedOffers
                            .map((o) => {
                                const r = <cinerinoapi.factory.order.IReservation>o.itemOffered;

                                return {
                                    qr_str: r.id,
                                    payment_no: paymentNo,
                                    performance: r.reservationFor.id
                                };
                            })
                        : []
                });
        } catch (error) {
            next(error);
        }
    }
);

// tslint:disable-next-line:max-func-body-length
function createPotentialActions(params: {
    transactionId: string;
    authorizeSeatReservationResult:
    cinerinoapi.factory.action.authorize.offer.seatReservation.IResult<cinerinoapi.factory.service.webAPI.Identifier.Chevre>;
    customer: cinerinoapi.factory.transaction.placeOrder.IAgent;
    profile: cinerinoapi.factory.person.IProfile;
    paymentMethodName: string;
    paymentNo: string;
}): {
    potentialActions: cinerinoapi.factory.transaction.placeOrder.IPotentialActionsParams;
    result: cinerinoapi.factory.transaction.placeOrder.IResultParams;
} {
    // 予約連携パラメータ作成
    // 予約連携パラメータ作成
    const authorizeSeatReservationResult = params.authorizeSeatReservationResult;
    if (authorizeSeatReservationResult === undefined) {
        throw new Error('No Seat Reservation');
    }
    const acceptedOffers = (Array.isArray(authorizeSeatReservationResult.acceptedOffers))
        ? authorizeSeatReservationResult.acceptedOffers
        : [];
    const reserveTransaction = authorizeSeatReservationResult.responseBody;
    if (reserveTransaction === undefined) {
        throw new cinerinoapi.factory.errors.Argument('Transaction', 'Reserve trasaction required');
    }
    const chevreReservations = (Array.isArray(reserveTransaction.object.reservations))
        ? reserveTransaction.object.reservations
        : [];
    const event = reserveTransaction.object.reservationFor;
    if (event === undefined || event === null) {
        throw new cinerinoapi.factory.errors.Argument('Transaction', 'Event required');
    }

    const transactionAgent = params.customer;
    if (transactionAgent === undefined) {
        throw new Error('No Transaction Agent');
    }

    const customerProfile = params.profile;
    if (customerProfile === undefined) {
        throw new Error('No Customer Profile');
    }

    // 予約確定パラメータを生成
    const eventReservations = acceptedOffers.map((acceptedOffer, index) => {
        const reservation = acceptedOffer.itemOffered;

        const chevreReservation = chevreReservations.find((r) => r.id === reservation.id);
        if (chevreReservation === undefined) {
            throw new cinerinoapi.factory.errors.Argument('Transaction', `Unexpected temporary reservation: ${reservation.id}`);
        }

        return temporaryReservation2confirmed({
            reservation: reservation,
            chevreReservation: chevreReservation,
            transactionId: params.transactionId,
            customer: transactionAgent,
            profile: customerProfile,
            paymentNo: params.paymentNo,
            gmoOrderId: '',
            paymentSeatIndex: index.toString(),
            paymentMethodName: params.paymentMethodName
        });
    });

    const confirmReservationParams: cinerinoapi.factory.transaction.placeOrder.IConfirmReservationParams[] = [];
    confirmReservationParams.push({
        object: {
            typeOf: reserveTransaction.typeOf,
            id: reserveTransaction.id,
            object: {
                reservations: [
                    ...eventReservations.map((r) => {
                        // プロジェクト固有の値を連携
                        return {
                            id: r.id,
                            additionalTicketText: r.additionalTicketText,
                            underName: r.underName,
                            additionalProperty: r.additionalProperty
                        };
                    }),
                    // 余分確保分の予約にもextraプロパティを連携
                    ...chevreReservations.filter((r) => {
                        // 注文アイテムに存在しない予約(余分確保分)にフィルタリング
                        const orderItem = eventReservations.find(
                            (eventReservation) => eventReservation.id === r.id
                        );

                        return orderItem === undefined;
                    })
                        .map((r) => {
                            return {
                                id: r.id,
                                additionalProperty: [
                                    { name: 'extra', value: '1' }
                                ]
                            };
                        })
                ]
            }
        }
    });

    const eventStartDateStr = moment(event.startDate)
        .tz('Asia/Tokyo')
        .format('YYYYMMDD');
    const confirmationNumber = `${eventStartDateStr}${params.paymentNo}`;
    const confirmationPass = (typeof customerProfile.telephone === 'string')
        // tslint:disable-next-line:no-magic-numbers
        ? customerProfile.telephone.slice(-4)
        : '9999';

    return {
        potentialActions: {
            order: {
                potentialActions: {
                    sendOrder: {
                        potentialActions: {
                            confirmReservation: confirmReservationParams
                        }
                    }
                }
            }
        },
        result: {
            order: {
                identifier: [
                    { name: 'confirmationNumber', value: confirmationNumber },
                    { name: 'confirmationPass', value: confirmationPass }
                ]
            }
        }
    };
}

/**
 * 仮予約から確定予約を生成する
 */
function temporaryReservation2confirmed(params: {
    reservation: cinerinoapi.factory.order.IReservation;
    chevreReservation: cinerinoapi.factory.chevre.reservation.IReservation<cinerinoapi.factory.chevre.reservationType.EventReservation>;
    transactionId: string;
    customer: cinerinoapi.factory.transaction.placeOrder.IAgent;
    profile: cinerinoapi.factory.person.IProfile;
    paymentNo: string;
    gmoOrderId: string;
    paymentSeatIndex: string;
    paymentMethodName: string;
}): cinerinoapi.factory.chevre.reservation.IReservation<cinerinoapi.factory.chevre.reservationType.EventReservation> {
    const customer = params.customer;

    const underName: cinerinoapi.factory.chevre.reservation.IUnderName<cinerinoapi.factory.chevre.reservationType.EventReservation> = {
        ...params.profile,
        typeOf: cinerinoapi.factory.personType.Person,
        id: customer.id,
        name: `${params.profile.givenName} ${params.profile.familyName}`,
        identifier: [
            { name: 'customerGroup', value: 'Customer' },
            { name: 'paymentNo', value: params.paymentNo },
            { name: 'transaction', value: params.transactionId },
            { name: 'gmoOrderId', value: params.gmoOrderId },
            ...(typeof params.profile.age === 'string')
                ? [{ name: 'age', value: params.profile.age }]
                : [],
            ...(Array.isArray(customer.identifier)) ? customer.identifier : [],
            ...(customer.memberOf !== undefined && customer.memberOf.membershipNumber !== undefined)
                ? [{ name: 'username', value: customer.memberOf.membershipNumber }]
                : [],
            ...(params.paymentMethodName !== undefined)
                ? [{ name: 'paymentMethod', value: params.paymentMethodName }]
                : []
        ]
    };

    return {
        ...params.chevreReservation,
        underName: underName,
        additionalProperty: [
            ...(Array.isArray(params.reservation.additionalProperty)) ? params.reservation.additionalProperty : [],
            { name: 'paymentSeatIndex', value: params.paymentSeatIndex }
        ],
        additionalTicketText: params.reservation.additionalTicketText
    };
}

export default placeOrderTransactionsRouter;
