function decimals(t) {
    const s = t.toString();
    return s.includes('.') ? s.split('.')[1].length : 0;
}

function norm(p, tick) {
    const t = tick || 0.01;
    return Number((Math.round(p / t) * t).toFixed(decimals(t)));
}

module.exports = {
    norm,
    decimals
};