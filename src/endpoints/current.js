const express = require('express');
const axios = require('axios');
const router = express.Router();

const port = process.env.PORT || 3000;

router.get('/:evaNo', async (req, res) => {
    const evaNo = req.params.evaNo;
    const date = req.query.date || new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const time = req.query.time || new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 2);

    try {
        // get the plan for this hour and the next hour from the local API
        const planResponseCurrentHour = await axios.get(`http://localhost:${port}/plan/${evaNo}/${date}/${time}`);
        // we are also fetching the next hour, but we need to consider that the next hour might be the first hour of the next day
        const nextHour = time === '23' ? '00' : (parseInt(time) + 1).toString();
        const nextDate = time === '23' ? new Date(new Date().getTime() + 24 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') : date;
        const planResponseNextHour = await axios.get(`http://localhost:${port}/plan/${evaNo}/${nextDate}/${nextHour}`);

        // merge the two responses
        const planResponse = {
            currentHour: planResponseCurrentHour.data,
            nextHour: planResponseNextHour.data
        };

        // get the known changes for this station
        const changesResponse = await axios.get(`http://localhost:${port}/fchg/${evaNo}`);


        const combinedResponse = {
            stationInfo: {
                evaNumber: evaNo,
                currentDate: date,
                currentTime: time
            },
            station: planResponseCurrentHour.data.timetable.station, // Assuming the station name is the same in both current and next hour
            stops: transformStops({ currentHour: planResponseCurrentHour.data, nextHour: planResponseNextHour.data }, changesResponse.data),
            messages: transformMessages(changesResponse.data)
        };

        res.json(combinedResponse);
    } catch (error) {
        console.error(error);
        return res.status(500).send('Error fetching plan');
    }
});

function transformStops(planData, changesData) {
    const currentHourStops = planData.currentHour.timetable.s;
    const nextHourStops = planData.nextHour.timetable.s;
    const stopsMap = {};
    currentHourStops.forEach(stop => stopsMap[stop.id] = stop);
    nextHourStops.forEach(stop => stopsMap[stop.id] = stop);
    
    // Complete mapping for the stop schema
    const stopsMapping = {
        eva: 'evaStation',
        id: 'stopId',
        ar: {
            friendlyName: 'arrivalEvent',
            mapping: {
                cde: 'changedEndpoint',
                clt: 'cancellationTime',
                cp: 'changedPlatform',
                cpth: 'changedPath',
                cs: 'eventStatus',
                ct: 'changedTime',
                dc: 'distantChange',
                hi: 'hidden',
                l: 'line',
                m: 'messages',
                pde: 'plannedEndpoint',
                pp: 'plannedPlatform',
                ppth: 'plannedPath',
                ps: 'connectionStatus',
                pt: 'plannedTime',
                tra: 'transition',
                wings: 'wings'
            }
        },
        dp: {
            friendlyName: 'departureEvent',
            mapping: {
                cde: 'changedEndpoint',
                clt: 'cancellationTime',
                cp: 'changedPlatform',
                cpth: 'changedPath',
                cs: 'eventStatus',
                ct: 'changedTime',
                dc: 'distantChange',
                hi: 'hidden',
                l: 'line',
                m: 'messages',
                pde: 'plannedEndpoint',
                pp: 'plannedPlatform',
                ppth: 'plannedPath',
                ps: 'connectionStatus',
                pt: 'plannedTime',
                tra: 'transition',
                wings: 'wings'
            }
        },
        conn: {
            friendlyName: 'connections',
            mapping: {
                cs: 'connectionStatus',
                eva: 'evaStation',
                id: 'connectionId',
                ts: 'timestamp'
            }
        },
        hd: {
            friendlyName: 'historicDelays',
            mapping: {
                ar: 'arrivalTime',
                cod: 'delayCause',
                dp: 'departureTime',
                src: 'delaySource',
                ts: 'timestamp'
            }
        },
        hpc: {
            friendlyName: 'historicPlatformChanges',
            mapping: {
                ar: 'arrivalPlatform',
                cot: 'causeOfTrackChange',
                dp: 'departurePlatform',
                ts: 'timestamp'
            }
        },
        m: 'messages',
        ref: 'referenceTrip',
        rtr: 'referenceTripRelation',
        tl: {
            friendlyName: 'tripLabel',
            mapping: {
                c: 'category',
                f: 'filterFlags',
                n: 'number',
                o: 'owner',
                t: 'tripType'
            }
        }
    };

    // Recursive helper to transform an object (including arrays)
    const transformObject = (obj, mapping) => {
        const result = {};
        Object.keys(obj).forEach(key => {
            if (mapping && mapping[key]) {
                let mapValue = mapping[key];
                let newKey, nestedMapping;
                if (typeof mapValue === 'string') {
                    newKey = mapValue;
                } else if (typeof mapValue === 'object' && mapValue.friendlyName) {
                    newKey = mapValue.friendlyName;
                    nestedMapping = mapValue.mapping;
                }
                if (nestedMapping && obj[key] && typeof obj[key] === 'object') {
                    if (Array.isArray(obj[key])) {
                        result[newKey] = obj[key].map(item => transformObject(item, nestedMapping));
                    } else {
                        result[newKey] = transformObject(obj[key], nestedMapping);
                    }
                } else {
                    result[newKey] = obj[key];
                }
            } else {
                result[key] = obj[key];
            }
        });
        return result;
    };

    // Transform the map back to an array with user-friendly keys
    let stops = Object.values(stopsMap).map(stop => transformObject(stop, stopsMapping));

    // Build a map of changes by stop id from changesData.timetable.s
    const changesArray = (changesData && changesData.timetable && changesData.timetable.s) || [];
    const changesMap = {};
    changesArray.forEach(change => {
        changesMap[change.id] = change;
    });

    // For each stop, if there is a corresponding change, add it as a 'change' property
    stops.forEach(stop => {
        if (changesMap[stop.stopId]) {
            // Optionally transform the change object using the same mapping
            stop.change = transformObject(changesMap[stop.stopId], stopsMapping);
        }
    });

    // Post-process stops to add Train field and remove unwanted fields
    stops.forEach(stop => {
        // Compute the new Train field from tripLabel.category and departureEvent.line.
        const tripCategory = stop.tripLabel && stop.tripLabel.category ? stop.tripLabel.category : '';
        const departureLine = stop.departureEvent && stop.departureEvent.line ? stop.departureEvent.line : '';
        stop.train = `${tripCategory}${departureLine}`;
        
        // Remove the entire tripLabel property.
        delete stop.tripLabel;
        
        // Remove the 'line' property from arrivalEvent and departureEvent if they exist.
        if (stop.arrivalEvent && stop.arrivalEvent.line) {
            delete stop.arrivalEvent.line;
        }
        if (stop.departureEvent && stop.departureEvent.line) {
            delete stop.departureEvent.line;
        }
        
        // For both arrivalEvent and departureEvent, combine plannedTime into date and time.
        ['arrivalEvent', 'departureEvent'].forEach(eventKey => {
            if (stop[eventKey]) {
                const event = stop[eventKey];
                const timeValue = event.plannedTime;
                if (typeof timeValue === 'string' && timeValue.length >= 10) {
                    event.date = timeValue.substr(0, 6);
                    event.time = timeValue.substr(6, 4);
                }
                delete event.plannedTime;
            }
        });

        // post-process the change object
        if (stop.change) {
            delete stop.change.stopId;
            delete stop.change.evaStation;

            if (stop.change.messages) {
                const fchgMessageMapping = {
                    c: 'code',
                    cat: 'category',
                    del: 'deleted',
                    dm: {
                        friendlyName: 'distributorMessage',
                        mapping: {
                            int: 'internalText',
                            n: 'distributorName',
                            t: 'distributorType',
                            ts: 'timestamp'
                        }
                    },
                    ec: 'externalCategory',
                    elnk: 'externalLink',
                    ext: 'externalText',
                    from: 'validFrom',
                    id: 'messageId',
                    o: 'owner',
                    pr: 'priority',
                    t: 'status',
                    tl: 'tripLabel',
                    to: 'validTo',
                    ts: 'timestamp'
                };
                const messages = Array.isArray(stop.change.messages)
                    ? stop.change.messages.map(msg => transformObject(msg, fchgMessageMapping))
                    : [transformObject(stop.change.messages, fchgMessageMapping)];
                stop.change.messages = messages;
            }
        }

    });
    
    return stops;
}

// Helper function to transform general messages
function transformMessages(messagesData) {
    if (!messagesData || !messagesData.timetable || !messagesData.timetable.m) return [];

    const messages = Array.isArray(messagesData.timetable.m) ? messagesData.timetable.m.map(msg => ({
        messageId: msg.id,
        timestamp: msg.ts,
        category: msg.cat,
        priority: msg.pr,
        text: msg.int || msg.ext
    })) : [{
        messageId: messagesData.timetable.m.id,
        timestamp: messagesData.timetable.m.ts,
        category: messagesData.timetable.m.cat,
        priority: messagesData.timetable.m.pr,
        text: messagesData.timetable.m.int || messagesData.timetable.m.ext
    }];

    return messages;
}

module.exports = router;