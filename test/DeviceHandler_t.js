const { expect } = require('chai');
const EventEmitter = require('events');
const DeviceHandler = require('../lib/DeviceHandler');

describe('DeviceHandler periodic values', function () {
    let handler, device, update, events, timers, now;

    const advance = ms => {
        const end = now + ms;
        while (true) {
            const next = [...timers.entries()].filter(([, t]) => t.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
        }
        now = end;
    };

    beforeEach(async function () {
        timers = new Map();
        now = 0;
        let id = 0;
        const homey = {
            setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; },
            clearTimeout(id) { timers.delete(id); }
        };
        const capability = { id: 'measure_temperature', type: 'number', value: 21 };
        device = {
            id: 'device', name: 'Sensor', zone: 'room',
            capabilities: [capability.id], capabilitiesObj: { [capability.id]: capability },
            makeCapabilityInstance(key, callback) { update = callback; return { destroy() {} }; }
        };
        handler = new DeviceHandler({ homey, repeatInterval: 300, api: {
            devices: new EventEmitter(), zones: new EventEmitter()
        }, log() {} });
        events = [];
        handler.on('capability', event => events.push(event));
        await handler._registerDevice(device);
    });

    it('repeats the initial value every 5 minutes with current zone metadata', function () {
        handler._createZone({ id: 'room', name: 'Living room' });
        advance(299999);
        expect(events).to.have.lengthOf(0);
        advance(1);
        expect(events[0]).to.include({ value: 21, zoneName: 'Living room' });
        advance(300000);
        expect(events).to.have.lengthOf(2);
    });

    it('sends changes immediately and resets the repeat timer', function () {
        advance(30000);
        update(22);
        expect(events.map(e => e.value)).to.deep.equal([22]);
        advance(299999);
        expect(events).to.have.lengthOf(1);
        advance(1);
        expect(events.map(e => e.value)).to.deep.equal([22, 22]);
    });

    it('defaults to disabled and still sends live updates', async function () {
        handler.unregisterDevices();
        handler = new DeviceHandler({ homey: handler.homey, api: {
            devices: new EventEmitter(), zones: new EventEmitter()
        }, log() {} });
        handler.on('capability', event => events.push(event));
        await handler._registerDevice(device);
        advance(600000);
        expect(timers.size).to.equal(0);
        expect(events).to.have.lengthOf(0);
        update(22);
        expect(events.map(e => e.value)).to.deep.equal([22]);
    });

    it('applies interval changes immediately and preserves the latest value', function () {
        update(22);
        handler.updateRepeatInterval(10);
        advance(9999);
        expect(events).to.have.lengthOf(1);
        advance(1);
        expect(events.map(e => e.value)).to.deep.equal([22, 22]);
        handler.updateRepeatInterval(20);
        advance(19999);
        expect(events).to.have.lengthOf(2);
        advance(1);
        expect(events).to.have.lengthOf(3);
        handler.updateRepeatInterval(0);
        advance(600000);
        expect(events).to.have.lengthOf(3);
        expect(timers.size).to.equal(0);
        update(23);
        handler.updateRepeatInterval(10);
        advance(10000);
        expect(events.map(e => e.value)).to.deep.equal([22, 22, 22, 23, 23]);
    });

    it('rejects invalid intervals without changing the active timer', function () {
        for (const value of [-1, 1, 9, 10.5, NaN, Infinity, '10', null]) {
            expect(() => handler.updateRepeatInterval(value)).to.throw('Capability repeat interval');
        }
        advance(300000);
        expect(events).to.have.lengthOf(1);
    });

    it('supports intervals beyond the maximum single Node timeout', function () {
        handler.updateRepeatInterval(2147484);
        advance(2147483999);
        expect(events).to.have.lengthOf(0);
        advance(1);
        expect(events).to.have.lengthOf(1);
        handler.unregisterDevices();
        expect(timers.size).to.equal(0);
    });

    it('repeats zero, false and enum values', function () {
        for (const value of [0, false, 'idle']) {
            update(value);
            advance(300000);
            expect(events[events.length - 1].value).to.equal(value);
        }
        expect(events).to.have.lengthOf(6);
    });

    it('does not send missing values', function () {
        update(null);
        advance(300000);
        update(undefined);
        advance(300000);
        expect(events).to.have.lengthOf(0);
    });

    it('cancels old timers when registering a capability again', function () {
        handler._registerCapability(device, device.capabilitiesObj.measure_temperature, 'measure_temperature');
        advance(300000);
        expect(events).to.have.lengthOf(1);
    });

    it('stops repeating when a device is removed', function () {
        handler._unregisterDevice(device.id);
        advance(600000);
        expect(events).to.have.lengthOf(0);
        expect(timers.size).to.equal(0);
    });

    it('stops repeating capabilities removed by a device update', async function () {
        device.capabilities = [];
        device.capabilitiesObj = {};
        await handler._registerDevice(device);
        advance(600000);
        expect(events).to.have.lengthOf(0);
        expect(timers.size).to.equal(0);
    });

    it('stops repeating on app cleanup', function () {
        handler.unregisterDevices();
        advance(600000);
        expect(events).to.have.lengthOf(0);
        expect(timers.size).to.equal(0);
    });
});
