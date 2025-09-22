// Read query string before we do any binding as it may remove it.
var s = location.search;
var usp = new URLSearchParams(s);

var sourceString = 'mru';
var sourceNeedsUpdate = false;


if (usp.has('w')) { // support ?w for older links but normalise to ?s
    sourceString = 'wru';
    usp.delete('w');
    sourceNeedsUpdate = true;
} else if (usp.get('s') === 'wru') {
    sourceString = 'wru';
} else if (usp.get('s') === 'mru') {
    sourceString = 'mru';
} else if (usp.has('s')) {
    sourceNeedsUpdate = true;
}

if (sourceNeedsUpdate) {
    usp.set('s', sourceString);
    var updatedQuery = usp.toString();
    history.replaceState(null, '', updatedQuery ? ('?' + updatedQuery) : location.pathname);
}

var dateString = usp.get('d');
var fixturesString = usp.get('f');

// Create the view model and bind it to the HTML.
var viewModel = new ViewModel(sourceString);
ko.applyBindings(viewModel);

// Load rankings from World Rugby.
var loadRankings = function (rankingsSource, startDate) {
    viewModel.rankingsSource(rankingsSource);
    $.get('https://api.wr-rims-prod.pulselive.com/rugby/v3/rankings/' + rankingsSource + (startDate ? ('?date=' + startDate) : '')).done(function (data) {
        var rankings = {};
        $.each(data.entries, function (i, e) {
            var maxLength = 15;
            e.team.displayName = e.team.name.length > maxLength ? e.team.abbreviation : e.team.name;
            e.team.displayTitle = e.team.name.length > maxLength ? e.team.name : null;

            viewModel.teams.push(e.team);
            rankings[e.team.id] = new RankingViewModel(e);
        });
        viewModel.rankingsById(rankings);

        var sorted = [];
        $.each(rankings, function (i, r) {
            sorted.push(r);
        });
        sorted.sort(function (a, b) { return b.pts() - a.pts(); });

        viewModel.baseRankings(sorted);
        viewModel.originalDate(data.effective.label);
        viewModel.originalMillis = data.effective.millis;
        viewModel.rankingsChoice('original');

        // There's a bug with historical MRU rankings where their effective date is set after the requested date (2020-09-21).
        // The effective date should never be in the future by more than a day, so we should be able to detect this and guess a date instead.
        // (It could be a little bit in the future because we ask for midnight but the rankings are published during the day.)
        ////var requestedStartDateMillis = new Date(startDate).getTime();
        ////if (viewModel.originalMillis > requestedStartDateMillis + (24 * 60 * 60 * 1000)) {
        // In fact ignore the millis and just compare the "label" as it's lexicographical and as it's just the date it should never be in the future.
        if (data.effective.label > startDate) {
            viewModel.originalDate(startDate);
            viewModel.originalMillis = new Date(startDate).getTime();
            viewModel.originalDateIsEstimated(true);
        }

        // When we're done, load fixtures in.
        if (fixturesString) {
            viewModel.fixturesString(fixturesString);
            viewModel.rankingsChoice('calculated');
            viewModel.queryString.subscribe(function (qs) {
                history.replaceState(null, '', '?' + qs);
            });
        } else {
            // This should be parallelisable if we have our observables set up properly. (Fixture validity depends on teams.)
            addFixture();
            loadFixtures(rankings, !!dateString);
        }
    });
};

loadRankings(sourceString, dateString);

// Helper to add a fixture to the top/bottom.
// If we had up/down buttons we could maybe get rid of this.
var addFixture = function (top, process) {
    var fixture = new FixtureViewModel(viewModel);
    if (process) {
        process(fixture);
    }

    if (top) {
        viewModel.fixtures.unshift(fixture);
    } else {
        viewModel.fixtures.push(fixture);
    }
}

// Load fixtures from World Rugby.
var loadFixtures = function(rankings, specifiedDate) {
    // Load a week of fixtures from when the rankings are dated.
    // (As that is what will make it into the next rankings.)
    // Or until next monday.
    function nextMonday() {
      var d = new Date();
      d.setDate(d.getDate() + ((7-d.getDay())%7) + 1);
      return d;
    }
    var rankingDate  = new Date(viewModel.originalDate());
    var from = formatDate( rankingDate );
    var toDate = specifiedDate ? rankingDate.addDays(7) : nextMonday();
    var to   =  formatDate( toDate );

    // We load all fixtures and eventually filter by matching teams.
    var url = "https://api.wr-rims-prod.pulselive.com/rugby/v3/match?startDate="+from+"&endDate="+to+"&sort=asc&pageSize=100&page=";
    var getFixtures = function (fixtures, page, then) {
        $.get(url + page).done(function(data) {
            if (data.content.length == 100) {
                getFixtures(fixtures.concat(data.content), page + 1, then);
            } else {
                then(fixtures.concat(data.content), rankings);
            }
        });
    };

    getFixtures([], 0, fixturesLoaded);
}

var fixturesLoaded = function (fixtures, rankings) {
    // N.B. since we add to the top, these get reversed, so reverse the order here!
    fixtures.reverse();

    // We make extra AJAX requests for any fixture with a venue in the hope of working out
    // if the home team has advantage.
    // Keep track of those here, so we can check when all queries are finished and subscribe
    // to the query string then.
    var anyQueries = false;
    var venueQueryCount = 0;
    var venueQueries = {};
    function queryVenue(id) {
        var query = venueQueries[id];
        if (!query) {
            query = $.get('https://api.wr-rims-prod.pulselive.com/rugby/v3/team/' + id);
            venueQueries[id] = query;
        }
        return query;
    }

    // Parse each fixture into a view model, which adds it to the array.
    $.each(fixtures, function (i, e) {
        // I don't think we can reliably only request fixtures relevant to loaded teams, so filter here.
        // For knockouts where a team may not be decided yet, allow team to be null or id to be 0
        if ((e.teams[0] && (e.teams[0].id != '0') && !rankings[e.teams[0].id]) || (e.teams[1] && (e.teams[1].id != '0') && !rankings[e.teams[1].id])) {
            return;
        };

        addFixture(true, function (fixture) {
            fixture.homeId(e.teams[0].id);
            if (e.teams[1]) fixture.awayId(e.teams[1].id); // See ANC above
            fixture.canEditTeams(false);
            fixture.noHome(false);
            fixture.switched(false);
            fixture.kickoff = $.formatDateTime('D dd/mm/yy hh:ii', new Date(e.time.millis));

            // Covid-TRC (noticed in 2021 but apparently also in 2020) ignores the stadium location
            // and treats the nominal home team as always at home
            var tournamentRespectsStadiumLocation = !e.events.some(function (event) {
                return event.label.match(/^202[01] Rugby Championship$/);
            });

            if (e.venue) {
                fixture.venueNameAndCountry = [e.venue.name, e.venue.country].join(', ');
                fixture.venueCity = e.venue.city;
                anyQueries = true;
                venueQueryCount++;
                queryVenue(e.teams[0].id).done(function(teamData) {
                    if (e.venue.country !== teamData.country) {
                        if (e.teams[1]) {
                            venueQueryCount++;
                            queryVenue(e.teams[1].id).done(function(teamData) {
                                if (e.venue.country === teamData.country) {
                                    // Saw this in the Pacific Nations Cup 2019 - a team was nominally Away
                                    // but in a home stadium. They seemed to get home nation advantage.
                                    if (tournamentRespectsStadiumLocation) {
                                        fixture.switched(true);
                                    }
                                } else {
                                    if (tournamentRespectsStadiumLocation) {
                                        fixture.noHome(true);
                                    }
                                }
                            }).always(function () {
                                venueQueryCount--;
                                if (venueQueryCount === 0) {
                                    viewModel.queryString.subscribe(function (qs) {
                                        history.replaceState(null, '', '?' + qs);
                                    });
                                }
                            });
                        } else { // See ANC above
                            // Don't know who the second team is, but we do know the first team isn't at home.
                            if (tournamentRespectsStadiumLocation) {
                                fixture.noHome(true);
                            }
                        }
                    }
                }).always(function () {
                    venueQueryCount--;
                    if (venueQueryCount === 0) {
                        viewModel.queryString.subscribe(function (qs) {
                            history.replaceState(null, '', '?' + qs);
                        });
                    }
                });
            }
            fixture.isRwc((e.events.length > 0 && e.events[0].rankingsWeight == 2) || (!!e.competition.match(/Rugby World Cup/)));

            // If the match isn't unstarted (or doesn't not have live scores), add
            // the live score.
            // U is unstarted / no live score.
            // UP/CC are postponed/cancelled and also have no live score.
            // C is complete.
            // L1/LH/L2 are I believe the codes for 1st half, half time, 2nd half but I forgot.
            if (e.status !== 'U' && e.status !== 'UP' && e.status !== 'CC') {
                fixture.result(calculateResultIndex(e.scores[0], e.scores[1]));
            }
            switch (e.status) {
                case 'U': {
                    // Try to detect if a match should have started by now, and just hasn't been reported by WR.
                    // Give it a bit of leeway.
                    var leeway = 5 * 60 * 1000; // 5 minutes
                    if (e.time.millis + leeway > new Date()) {
                        fixture.liveScoreMode = 'Upcoming';
                    } else {
                        fixture.liveScoreMode = 'Unreported';
                    }
                    break;
                }
                case 'UP': fixture.liveScoreMode = 'Postponed'; break;
                case 'CC': fixture.liveScoreMode = 'Cancelled'; break;
                case 'C': {
                    fixture.liveScoreMode = 'Complete';
                    // WR started publishing rankings on match days during the world cup.
                    // Try to work out if the match is already included in the rankings.
                    // We know it is "complete" because we're in that case.
                    // Try to ensure it ended before the ranking timestamp.
                    // (If we used the start time here we would block events that were in progress when
                    // the rankings were published, which obviously can't have been in the rankings.)
                    // This will incorrectly exclude a match that has completed, if WR published rankings
                    // 90 minutes after it started that didn't include the result.
                    // This will incorrectly include a match that is not marked as complete but is included
                    // in the rankings, or that finished and was included in the rankings less than 90
                    // minutes after it kicked off.
                    var kickoffMillis = e.time.millis;
                    var endMillis = kickoffMillis + 90 * 60 * 1000;
                    if (endMillis < viewModel.originalMillis) {
                        fixture.alreadyInRankings = true;
                    }
                    break;
                }
                case 'L1': fixture.liveScoreMode = 'First half'; break;
                case 'L2': fixture.liveScoreMode = 'Second half'; break;
                case 'LHT': fixture.liveScoreMode = 'Half time'; break;
            }
        });
    });

    if (!anyQueries) {
        viewModel.queryString.subscribe(function (qs) {
            history.replaceState(null, '', '?' + qs);
        });
    }
};

// Format a date for the fixture or rankings API call.
var formatDate = function(date) {
    var d     = new Date(date),
        month = '' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1),
        day   = '' + (d.getDate() < 10 ? '0' : '') + d.getDate(),
        year  = d.getFullYear();

    return [year, month, day].join('-');
}

// Add days to a date.
Date.prototype.addDays = function (d) {
    if (d) {
        var t = this.getTime();
        t = t + (d * 86400000);
        this.setTime(t);
    }
    return this;
};

// Taken from SO https://stackoverflow.com/questions/30043773/knockout-input-readonly-state/30101073#30101073
// User Yvan https://stackoverflow.com/users/3738129/yvan
// Adjusted to add disabled attrbute, not enabled
ko.bindingHandlers.disabled = {
    update: function (element, valueAccessor) {
        if (ko.utils.unwrapObservable(valueAccessor())) {
            element.setAttribute('disabled', true);
        } else {
            element.removeAttribute('disabled');
        }
    }
};
ko.bindingHandlers.title = {
    update: function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor());
        if (value) {
            element.setAttribute('title', value);
        } else {
            element.removeAttribute('title');
        }
    }
}
