"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * ウェブフックルーター
 */
const ttts = require("@tokyotower/domain");
const express = require("express");
const mongoose = require("mongoose");
const webhooksRouter = express.Router();
const http_status_1 = require("http-status");
webhooksRouter.post('/onPlaceOrder', (req, res, next) => __awaiter(this, void 0, void 0, function* () {
    try {
        const order = req.body.data;
        if (order !== undefined && order !== null && typeof order.orderNumber === 'string') {
            const taskRepo = new ttts.repository.Task(mongoose.connection);
            const taskAttribute = {
                name: ttts.factory.taskName.CreatePlaceOrderReport,
                status: ttts.factory.taskStatus.Ready,
                runsAt: new Date(),
                remainingNumberOfTries: 10,
                numberOfTried: 0,
                executionResults: [],
                data: {
                    order: order
                }
            };
            yield taskRepo.save(taskAttribute);
        }
        res.status(http_status_1.NO_CONTENT)
            .end();
    }
    catch (error) {
        next(error);
    }
}));
webhooksRouter.post('/onReturnOrder', (req, res, next) => __awaiter(this, void 0, void 0, function* () {
    try {
        const order = req.body.data;
        if (order !== undefined && order !== null && typeof order.orderNumber === 'string') {
            const taskRepo = new ttts.repository.Task(mongoose.connection);
            const taskAttribute = {
                name: ttts.factory.taskName.CreateReturnOrderReport,
                status: ttts.factory.taskStatus.Ready,
                runsAt: new Date(),
                remainingNumberOfTries: 10,
                numberOfTried: 0,
                executionResults: [],
                data: {
                    order: order
                }
            };
            yield taskRepo.save(taskAttribute);
        }
        res.status(http_status_1.NO_CONTENT)
            .end();
    }
    catch (error) {
        next(error);
    }
}));
/**
 * 予約確定イベント
 */
webhooksRouter.post('/onReservationConfirmed', (req, res, next) => __awaiter(this, void 0, void 0, function* () {
    try {
        const reservation = req.body.data;
        if (reservation !== undefined && reservation !== null && typeof reservation.reservationNumber === 'string') {
            const reservationRepo = new ttts.repository.Reservation(mongoose.connection);
            const taskRepo = new ttts.repository.Task(mongoose.connection);
            // 予約データを作成する
            yield reservationRepo.saveEventReservation(Object.assign({}, reservation, { checkins: [] }));
            // 集計タスク作成
            const task = {
                name: ttts.factory.taskName.AggregateEventReservations,
                status: ttts.factory.taskStatus.Ready,
                runsAt: new Date(),
                remainingNumberOfTries: 3,
                numberOfTried: 0,
                executionResults: [],
                data: {
                    id: reservation.reservationFor.id
                }
            };
            yield taskRepo.save(task);
        }
        res.status(http_status_1.NO_CONTENT)
            .end();
    }
    catch (error) {
        next(error);
    }
}));
exports.default = webhooksRouter;
