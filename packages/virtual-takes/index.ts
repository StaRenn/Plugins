import { PluginInterface, ExecutedOrder, DebutCore, Candle, OrderType } from '@debut/types';

export type VirtualTakesOptions = {
    stopLoss: number; // Стоп лосс
    takeProfit: number; // Тейк профит
    trailing?: boolean;
    ignoreTicks?: boolean;
};

type OrderTakes = {
    takePrice: number;
    stopPrice: number;
    price: number;
};

type TakesLookup = Record<string, OrderTakes>;

export function virtualTakesPlugin(opts: VirtualTakesOptions): PluginInterface {
    const lookup: TakesLookup = {};
    async function handleTick(debut: DebutCore, tick: Candle) {
        const price = tick.c;
        // Нет заявки активной - нет мониторинга
        if (!debut.orders.length) {
            return;
        }

        for (const order of [...debut.orders]) {
            if (!('orderId' in order)) {
                continue;
            }

            if (opts.trailing) {
                trailingTakes(order, price, lookup);
            }

            if (!order.processing && checkClose(order, price, lookup)) {
                await debut.closeOrder(order);
            }
        }
    }

    return {
        name: 'takes',

        async onOpen(order) {
            createTakes(order, opts, lookup);
        },

        async onClose(order) {
            if (order.openId) {
                delete lookup[order.openId];
            }
        },

        async onCandle(tick) {
            if (opts.ignoreTicks) {
                await handleTick(this.debut, tick);
            }
        },

        async onTick(tick) {
            if (!opts.ignoreTicks) {
                await handleTick(this.debut, tick);
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
        throw 'Unknown take data';
    }

    return type === OrderType.BUY ? price >= takePrice || price <= stopPrice : price <= takePrice || price >= stopPrice;
}

function createTakes(order: ExecutedOrder, opts: VirtualTakesOptions, lookup: TakesLookup) {
    const { type, price, cid } = order;
    const rev = type === OrderType.SELL ? -1 : 1;

    // XXX Так как тейки и стопы виртуальные, можем их не делать реальными ценами с шагом
    const stopPrice = price - rev * price * (opts.stopLoss / 100);
    const takePrice = price + rev * price * (opts.takeProfit / 100);

    lookup[cid] = { stopPrice, takePrice, price };
}

function trailingTakes(order: ExecutedOrder, price: number, lookup: TakesLookup) {
    const { cid } = order;
    const takes = lookup[cid];

    if (!takes) {
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
