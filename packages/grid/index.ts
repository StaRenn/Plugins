import { PluginInterface, ExecutedOrder, OrderType } from '@debut/types';
import { math } from '@debut/plugin-utils';

type Grid = {
    lowLevels: number[];
    upLevels: number[];
};

export type GridPluginOptions = {
    distance: number; // дистанция первого уровня или всех, если не включен фибо
    fibo?: boolean; // фибоначи уровни
    martingale: number; // коэффициент мартингейла от 1-2
    levelsCount: number; // кол-во уровней грида
    takeProfit: number; // тейк в процентах 3 5 7 9 и тд
    stopLoss: number; // общий стоп в процентах для всего грида
    reversed?: boolean; // использовать грид для докупок
    reduceEquity?: boolean; // уменьшать доступный баланс с каждой сделкой
};

export function gridPlugin(opts: GridPluginOptions): PluginInterface {
    let grid: Grid | null;
    let startMultiplier: number;

    if (!opts.levelsCount) {
        opts.levelsCount = 6;
    }

    return {
        name: 'takes',

        onInit() {
            startMultiplier = this.debut.opts.lotsMultiplier || 1;
        },

        async onOpen(order) {
            if (!grid) {
                grid = createGrid(order, opts);
            }
        },

        async onTick(tick) {
            if (this.debut.orders.length) {
                const profit = profitMonitor(this.debut.orders, tick.c);
                const percentProfit = (profit / this.debut.opts.amount) * 100;

                if (percentProfit >= opts.takeProfit || percentProfit <= -opts.stopLoss) {
                    grid = null;
                    await this.debut.closeAll();
                    // Вернем лотность наместо
                    this.debut.opts.lotsMultiplier = startMultiplier;

                    if (opts.reduceEquity) {
                        if (!this.debut.opts.equityLevel) {
                            this.debut.opts.equityLevel = 1;
                        }

                        this.debut.opts.equityLevel *= 0.97;

                        if (this.debut.opts.equityLevel < 0.002) {
                            console.log(this.debut.getName(), 'Grid Disposed', new Date().toLocaleDateString());
                            this.debut.dispose();
                        }
                    }
                    return;
                }
            }

            if (grid) {
                if (tick.c <= grid.lowLevels[0]) {
                    grid.lowLevels.shift();

                    const lotsMulti = opts.martingale ** (opts.levelsCount - grid.lowLevels.length);
                    this.debut.opts.lotsMultiplier = lotsMulti;

                    await this.debut.createOrder(opts.reversed ? OrderType.BUY : OrderType.SELL);
                }

                if (tick.c >= grid.upLevels[0]) {
                    grid.upLevels.shift();

                    const lotsMulti = opts.martingale ** (opts.levelsCount - grid.upLevels.length);
                    this.debut.opts.lotsMultiplier = lotsMulti;

                    await this.debut.createOrder(opts.reversed ? OrderType.SELL : OrderType.BUY);
                }
            }
        },
    };
}

function createGrid(order: ExecutedOrder, options: GridPluginOptions): Grid {
    const lowLevels = [];
    const upLevels = [];

    const step = order.price * (options.distance / 100);
    const fiboSteps: number[] = [step];

    for (let i = 1; i <= options.levelsCount; i++) {
        if (options.fibo) {
            const fiboStep = fiboSteps.slice(-2).reduce((sum, item) => item + sum, 0);

            fiboSteps.push(fiboStep);

            upLevels.push(order.price + fiboStep);
            lowLevels.push(order.price - fiboStep);
        } else {
            upLevels.push(order.price + step * i);
            lowLevels.push(order.price - step * i);
        }
    }

    return { lowLevels, upLevels };
}

function profitMonitor(orders: ExecutedOrder[], price: number) {
    let totalProfit = 0;

    for (const order of orders) {
        totalProfit += getProfit(order, price);
    }

    return totalProfit;
}

function getProfit(order: ExecutedOrder, price: number) {
    const rev = order.type === OrderType.SELL ? -1 : 1;

    return (math.percentChange(price, order.price) / 100) * rev * order.executedLots;
}
