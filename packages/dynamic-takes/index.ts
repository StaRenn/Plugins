import { PluginInterface, ExecutedOrder, Candle, PluginCtx, OrderType } from '@debut/types';
import { orders } from '@debut/plugin-utils';

export interface DynamicTakesPlugin extends PluginInterface {
    name: 'dynamicTakes';
    api: Methods;
}

export const enum CloseType {
    STOP,
    TAKE,
}

export type DynamicTakesPluginOptions = {
    trailing?: boolean;
    ignoreTicks?: boolean;
    maxRetryOrders?: number;
};

interface Methods {
    setForOrder(cid: number, takePrice: number, stopPrice: number): void;
    getTakes(cid: number): OrderTakes;
}

type OrderTakes = {
    takePrice: number;
    stopPrice: number;
    price?: number;
    tryLeft?: number;
};

export interface DynamicTakesPluginAPI {
    dynamicTakes: Methods;
}

type TakesLookup = Record<string, OrderTakes>;

export function dynamicTakesPlugin(opts: DynamicTakesPluginOptions): PluginInterface {
    const lookup: TakesLookup = {};
    let ctx: PluginCtx;

    async function handleTick(tick: Candle) {
        const price = tick.c;
        const orderCount = ctx.debut.orders.length;
        // No orders => no tracking
        if (!orderCount) {
            return;
        }

        if (opts.maxRetryOrders && orderCount === opts.maxRetryOrders + 1) {
            const profit = orders.getCurrencyBatchProfit(ctx.debut.orders, tick.c);

            if (profit >= 0) {
                await ctx.debut.closeAll();
            }

            return;
        }

        let newOrder: ExecutedOrder | null = null;

        for (const order of [...ctx.debut.orders]) {
            if (!('orderId' in order)) {
                continue;
            }

            if (opts.trailing) {
                trailingTakes(order, price, lookup);
            }

            const closeReason = checkClose(order, price, lookup);
            const takes = lookup[order.orderId];

            // Stop achieved
            if (opts.maxRetryOrders! > 0 && !order.processing && closeReason === CloseType.STOP) {
                // Move takes

                takes.stopPrice += takes.stopPrice - order.price;
                takes.takePrice = takes.takePrice;

                // Create same type as origin order
                if (!newOrder) {
                    newOrder = await ctx.debut.createOrder(order.type);
                    lookup[newOrder.orderId] = {
                        takePrice: takes.takePrice,
                        stopPrice: takes.stopPrice,
                    };
                }
            } else if (closeReason === CloseType.STOP || closeReason === CloseType.TAKE) {
                await ctx.debut.closeOrder(order);
            }
        }
    }

    return {
        name: 'dynamicTakes',

        api: {
            setForOrder(cid: number, takePrice: number, stopPrice: number) {
                if (!takePrice || !stopPrice) {
                    throw `prices in setForOrder() should be a number, current take: ${takePrice}, stop: ${stopPrice}`;
                }

                // Only for orders seted up using API
                lookup[cid] = { takePrice, stopPrice, tryLeft: opts.maxRetryOrders };
            },
            getTakes(cid: number) {
                return lookup[cid];
            },
        },

        onInit() {
            ctx = this;
        },

        async onClose(order, closing) {
            delete lookup[closing.cid];
        },

        async onCandle(candle) {
            if (opts.ignoreTicks) {
                await handleTick(candle);
            }
        },

        async onTick(tick) {
            if (!opts.ignoreTicks) {
                await handleTick(tick);
            }
        },
    };
}

/**
 * Проверяем достижение тейка на оснвании текущей цены
 */
function checkClose(order: ExecutedOrder, price: number, lookup: TakesLookup) {
    const { type, cid } = order;
    const { takePrice, stopPrice } = lookup[cid] || {};

    if (!takePrice || !stopPrice) {
        // Order is not added to plugin, skip this
        return;
    }

    const isBuy = type === OrderType.BUY;

    if (isBuy ? price >= takePrice : price <= takePrice) {
        return CloseType.TAKE;
    } else if (isBuy ? price <= stopPrice : price >= stopPrice) {
        return CloseType.STOP;
    }

    return;
}

function trailingTakes(order: ExecutedOrder, price: number, lookup: TakesLookup) {
    const { cid } = order;
    const takes = lookup[cid];

    if (!takes) {
        return;
    }

    if (!takes.price) {
        takes.price = price;
        return;
    }

    if (
        (order.type === OrderType.BUY && price > takes.price) ||
        (order.type === OrderType.SELL && price < takes.price)
    ) {
        const delta = price - takes.price;

        takes.takePrice += delta;
        takes.stopPrice += delta;
        takes.price = price;
    }
}
