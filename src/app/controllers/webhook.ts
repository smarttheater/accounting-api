import * as cinerinoapi from '@cinerino/sdk';
import * as ttts from '@tokyotower/domain';
import * as moment from 'moment-timezone';

interface ICheckin {
    when: Date; // いつ
    where: string; // どこで
    why: string; // 何のために
    how: string; // どうやって
    /**
     * アクションID
     */
    id?: string;
    instrument?: {
        /**
         * 入場に使用するトークン
         */
        token?: string;
    };
}

/**
 * イベント変更検知時の処理
 */
export function onEventChanged(params: cinerinoapi.factory.chevre.event.IEvent<cinerinoapi.factory.chevre.eventType.ScreeningEvent>) {
    return async (repos: {
        performance: ttts.repository.Performance;
        task: ttts.repository.Task;
    }) => {
        const event = params;

        // パフォーマンス登録
        const performance: ttts.factory.performance.IPerformance = {
            project: params.project,
            id: event.id,
            startDate: moment(event.startDate)
                .toDate(),
            endDate: moment(event.endDate)
                .toDate(),
            eventStatus: event.eventStatus,
            additionalProperty: event.additionalProperty,
            ttts_extension: {
                ev_service_update_user: '',
                online_sales_update_user: '',
                refund_status: ttts.factory.performance.RefundStatus.None,
                refund_update_user: '',
                refunded_count: 0
            }
        };

        await repos.performance.saveIfNotExists(performance);
    };
}

/**
 * 注文返品時の情報連携
 */
export function onOrderReturned(params: cinerinoapi.factory.order.IOrder) {
    return async (repos: {
        performance: ttts.repository.Performance;
    }) => {
        const order = params;
        const event = (<cinerinoapi.factory.order.IReservation>order.acceptedOffers[0].itemOffered).reservationFor;

        // 販売者都合の手数料なし返品であれば、情報連携
        let cancellationFee = 0;
        if (order.returner !== undefined && order.returner !== null) {
            const returner = order.returner;
            if (Array.isArray(returner.identifier)) {
                const cancellationFeeProperty = returner.identifier.find((p: any) => p.name === 'cancellationFee');
                if (cancellationFeeProperty !== undefined) {
                    cancellationFee = Number(cancellationFeeProperty.value);
                }
            }
        }

        let reason: string = cinerinoapi.factory.transaction.returnOrder.Reason.Customer;
        if (order.returner !== undefined && order.returner !== null) {
            const returner = order.returner;
            if (Array.isArray(returner.identifier)) {
                const reasonProperty = returner.identifier.find((p: any) => p.name === 'reason');
                if (reasonProperty !== undefined) {
                    reason = reasonProperty.value;
                }
            }
        }

        if (reason === cinerinoapi.factory.transaction.returnOrder.Reason.Seller && cancellationFee === 0) {
            // パフォーマンスに返品済数を連携
            await repos.performance.updateOne(
                { _id: event.id },
                {
                    $inc: {
                        'ttts_extension.refunded_count': 1,
                        'ttts_extension.unrefunded_count': -1
                    },
                    'ttts_extension.refund_update_at': new Date()
                }
            );

            // すべて返金完了したら、返金ステータス変更
            await repos.performance.updateOne(
                {
                    _id: event.id,
                    'ttts_extension.unrefunded_count': 0
                },
                {
                    'ttts_extension.refund_status': ttts.factory.performance.RefundStatus.Compeleted,
                    'ttts_extension.refund_update_at': new Date()
                }
            );
        }
    };
}

/**
 * 予約取消時処理
 */
export function onReservationStatusChanged(
    params: cinerinoapi.factory.chevre.reservation.IReservation<cinerinoapi.factory.chevre.reservationType.EventReservation>
) {
    return async (repos: {
        reservation: ttts.repository.Reservation;
        task: ttts.repository.Task;
    }) => {
        const reservation = params;

        switch (reservation.reservationStatus) {
            case cinerinoapi.factory.chevre.reservationStatusType.ReservationCancelled:
                // 東京タワーDB側の予約もステータス変更
                // await repos.reservation.cancel({ id: reservation.id });
                await repos.reservation.reservationModel.findOneAndUpdate(
                    { _id: reservation.id },
                    {
                        reservationStatus: cinerinoapi.factory.chevre.reservationStatusType.ReservationCancelled,
                        modifiedTime: new Date()
                    }
                )
                    .exec();

                break;

            case cinerinoapi.factory.chevre.reservationStatusType.ReservationConfirmed:
                // 予約データを作成する
                const tttsResevation:
                    cinerinoapi.factory.chevre.reservation.IReservation<cinerinoapi.factory.chevre.reservationType.EventReservation>
                    = {
                    ...reservation,
                    reservationFor: {
                        ...reservation.reservationFor,
                        doorTime: (reservation.reservationFor.doorTime !== undefined)
                            ? moment(reservation.reservationFor.doorTime)
                                .toDate()
                            : undefined,
                        endDate: moment(reservation.reservationFor.endDate)
                            .toDate(),
                        startDate: moment(reservation.reservationFor.startDate)
                            .toDate()
                    },
                    ...{
                        checkins: []
                    }
                };
                // await repos.reservation.saveEventReservation(tttsResevation);
                await repos.reservation.reservationModel.findByIdAndUpdate(
                    tttsResevation.id,
                    { $setOnInsert: tttsResevation },
                    { upsert: true }
                )
                    .exec();

                break;

            case cinerinoapi.factory.chevre.reservationStatusType.ReservationHold:
                // 車椅子予約であれば、レート制限

                break;

            case cinerinoapi.factory.chevre.reservationStatusType.ReservationPending:
                break;

            default:
        }
    };
}

/**
 * 予約使用アクション変更イベント処理
 */
export function onActionStatusChanged(
    params: ttts.factory.chevre.action.IAction<ttts.factory.chevre.action.IAttributes<ttts.factory.chevre.actionType, any, any>>
) {
    return async (repos: {
        report: ttts.repository.Report;
        reservation: ttts.repository.Reservation;
    }) => {
        const action = params;

        if (action.typeOf === ttts.factory.chevre.actionType.UseAction) {
            const actionObject = action.object;
            if (Array.isArray(actionObject)) {
                const reservations =
                    <ttts.factory.chevre.reservation.IReservation<ttts.factory.chevre.reservationType.EventReservation>[]>
                    actionObject;

                const checkedin = action.actionStatus === ttts.factory.chevre.actionStatusType.CompletedActionStatus;
                const checkinDate: string = checkedin
                    ? moment(action.startDate)
                        .tz('Asia/Tokyo')
                        .format('YYYY/MM/DD HH:mm:ss')
                    : '';

                const agentIdentifier = action.agent.identifier;

                let when: string = '';
                let where: string | undefined;
                let why: string | undefined;
                let how: string | undefined;
                if (Array.isArray(agentIdentifier)) {
                    when = <string>agentIdentifier.find((p) => p.name === 'when')?.value;
                    where = agentIdentifier.find((p) => p.name === 'where')?.value;
                    why = agentIdentifier.find((p) => p.name === 'why')?.value;
                    how = agentIdentifier.find((p) => p.name === 'how')?.value;
                }

                const checkin: ICheckin = {
                    when: moment(when)
                        .toDate(),
                    where: (typeof where === 'string') ? where : '',
                    why: (typeof why === 'string') ? why : '',
                    how: (typeof how === 'string') ? how : '',
                    id: action.id
                };

                await Promise.all(reservations.map(async (reservation) => {
                    if (reservation.typeOf === ttts.factory.chevre.reservationType.EventReservation
                        && typeof reservation.id === 'string'
                        && reservation.id.length > 0) {
                        // レポートに反映
                        await repos.report.updateAttendStatus({
                            reservation: { id: reservation.id },
                            checkedin: checkedin ? 'TRUE' : 'FALSE',
                            checkinDate: checkinDate
                        });

                        // 入場履歴を反映
                        if (action.actionStatus === ttts.factory.chevre.actionStatusType.CompletedActionStatus) {
                            await repos.reservation.reservationModel.findByIdAndUpdate(
                                reservation.id,
                                {
                                    $push: { checkins: checkin },
                                    $set: {
                                        checkedIn: true,
                                        attended: true,
                                        modifiedTime: new Date()
                                    }
                                },
                                { new: true }
                            )
                                .exec();
                        } else if (action.actionStatus === ttts.factory.chevre.actionStatusType.CanceledActionStatus) {
                            await repos.reservation.reservationModel.findByIdAndUpdate(
                                reservation.id,
                                { $pull: { checkins: { when: checkin.when } } },
                                { new: true }
                            )
                                .exec();
                        }
                    }
                }));
            }
        }
    };
}
