const {store,addCandle,trim} = require("./memoryStore");
const {alignTimestamp} = require("./timeUtils");

function updateHigherTF(){

    const baseArr = store.candles["30s"];
    if(baseArr.length === 0) return;

    const lastBase = baseArr[baseArr.length - 1];
    const time = lastBase.time;

    // Check each timeframe
    const tfs = {
        "1m": 2,
        "5m": 10,
        "15m": 30,
        "30m": 60,
        "1h": 120,
        "2h": 240
    };

    for(const tf in tfs){
        const alignedTime = alignTimestamp(time,tf);
        const tfArr = store.candles[tf];
        const lastInTf = tfArr[tfArr.length - 1];

        // If this 30s candle starts a new higher TF candle, or if TF is empty
        if(!lastInTf || lastInTf.time !== alignedTime){
             // We only build when we have enough base candles for a full TF? 
             // Actually, usually we build as we go, but here 'build' takes 'count'
             // If we want to build a NEW candle, we need the last 'count' candles.
             // But if we just started, we might not have 'count' candles.
             if(baseArr.length >= tfs[tf]){
                 build(tf,tfs[tf]);
             }
        } else {
            // Update the current candle?
            // The user's original logic only pushed new candles.
            // Let's improve it to update the last candle in higher TF
            updateLast(tf,lastBase);
        }
    }
}

function updateLast(tf,baseCandle){
    const arr = store.candles[tf];
    if(arr.length === 0) return;
    let last = arr[arr.length - 1];
    
    last.high = Math.max(last.high,baseCandle.high);
    last.low = Math.min(last.low,baseCandle.low);
    last.close = baseCandle.close;
    last.volume += baseCandle.volume;
}

function build(tf,count){

    const base = store.candles["30s"].slice(-count);
    if(base.length === 0) return;

    const candle = {
        time:alignTimestamp(base[0].time,tf),
        open:base[0].open,
        high:Math.max(...base.map(c=>c.high)),
        low:Math.min(...base.map(c=>c.low)),
        close:base[base.length-1].close,
        volume:base.reduce((a,b)=>a+b.volume,0)
    };

    addCandle(tf,candle);
    trim(tf,500);

}

module.exports = {
    updateHigherTF
};