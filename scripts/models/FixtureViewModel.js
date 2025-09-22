// View model for a fixture entry.
// Pass the parent view model to check for validity.
// Should probably be able to pass the raw data from the API here.
var FIXTURE_OUTCOME_OPTIONS = [
    { value: 0, label: 'Home win by 16+' },
    { value: 1, label: 'Home win by 1-15' },
    { value: 2, label: 'Draw' },
    { value: 3, label: 'Away win by 1-15' },
    { value: 4, label: 'Away win by 16+' }
];

var FixtureViewModel = function (parent) {
    this.homeId = ko.observable();
    this.awayId = ko.observable();
    this.result = ko.observable();

    this.homeRankingBefore = ko.observable();
    this.awayRankingBefore = ko.observable();

    this.venueNameAndCountry = null;
    this.venueCity = null;
    this.liveScoreMode = null;
    this.kickoff = null;
    this.alreadyInRankings = false;
    this.canEditTeams = ko.observable(true);

    // Placeholder captions used until teams are selected in the fixture row.
    this.homeCaption = 'Home...';
    this.awayCaption = 'Away...';
    this.eventPhase = null;

    this.outcomeCaption = 'Outcome...';
    this.outcomeOptions = FIXTURE_OUTCOME_OPTIONS;

    this.noHome = ko.observable();
    this.switched = ko.observable();
    this.isRwc = ko.observable();

    this.hasValidTeams = ko.computed(function () {
        var rankings = parent.rankingsById();
        var home = rankings[this.homeId()];
        var away = rankings[this.awayId()];
        return home && away && home != away;
    }, this);

    this.isValid = ko.computed(function() {
        var result = parseInt(this.result(), 10);

        return this.hasValidTeams() && !isNaN(result);
    }, this);

    this.changes = ko.computed(function () {
        var noHome = this.noHome();
        var switched = this.switched();

        // Calculate the effective ranking of the "home" team depending on whether
        // it is really at home, or at a neutral venue, or even if the home team
        // is nominally away.
        var homeRanking = this.homeRankingBefore();
        if (!noHome) {
            if (!switched) {
                homeRanking = homeRanking + 3;
            } else {
                homeRanking = homeRanking - 3;
            }
        }

        // Calculate the ranking diff and cap it at 10 points.
        var rankingDiff = this.awayRankingBefore() - homeRanking; // home is higher = home loss, away is higher = away loss
        var cappedDiff = Math.min(10, Math.max(-10, rankingDiff));

        // A draw gives the home team one tenth of the diff.
        var drawChange = cappedDiff / 10;

        var rwcMult = this.isRwc() ? 2 : 1;
        return [
            rwcMult * 1.5 * (drawChange + 1),
            rwcMult * (drawChange + 1),
            rwcMult * drawChange,
            rwcMult * (drawChange - 1),
            rwcMult * 1.5 * (drawChange - 1)
        ];
    }, this);

    this.getDisplayChange = function(index) {
        var changes = this.changes();
        if (!changes) return null;
        var change = changes[index];
        if (isNaN(change)) return null;

        var formattedChange = Math.abs(change).toFixed(2);
        var prefix = change > 0 ? '<' : '';
        var suffix = change < 0 ? '>' : '';

        return prefix + formattedChange + suffix;
    };

    this.activeChange = ko.computed(function () {
        if (!this.isValid()) {
            return null;
        }

        var result = parseInt(this.result(), 10);
        if (isNaN(result)) {
            return null;
        }

        return result;
    }, this);

    return this;
};