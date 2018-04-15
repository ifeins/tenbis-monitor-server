const moment = require('moment-timezone');
const Hebcal = require('hebcal');
const values = require('object.values');

if (!Object.values) {
  values.shim();
}

const HOLIDAY_NAMES = [
  "Pesach: 1",
  "Pesach: 2",
  "Pesach: 7",
  "Pesach: 8",
  "Erev Shavuot",
  "Shavuot 1",
  "Yom HaAtzma\'ut",
  "Erev Rosh Hashana",
  "Rosh Hashana 1",
  "Rosh Hashana 2",
  "Erev Yom Kippur",
  "Yom Kippur",
  "Erev Sukkot",
  "Sukkot: 1",
  "Shmini Atzeret",
  "Simchat Torah",
];

const TimeUtils = {};

TimeUtils.getWorkDays = function(year, month) {
  let date = moment([year, month, 1]);
  let workDays = 0;
  const holidays = TimeUtils.getMonthHolidays(year, month);

  // as long as we haven't moved to the next month
  while (date.month() == month) {
    if (TimeUtils.isWorkDay(holidays, date)) {
      workDays++;
    }

    date = date.add(1, 'days');
  }

  return workDays;
}

TimeUtils.getMonthHolidays = function(year, month) {
  const gregYear = new Hebcal.GregYear(year, month + 1);
  const holidays = 
    Object.values(gregYear.holidays).map(event => {
      return {
        name: event[0].desc[0], 
        date: event[0].date.greg()
      }
    })
    .filter(event => HOLIDAY_NAMES.includes(event.name));

  return holidays;
}

TimeUtils.isWorkDay = function(holidays, date) {
  // Fri: 5, Sat: 6
  return date.day() < 5 && !TimeUtils.isHoliday(holidays, date);
}

TimeUtils.isHoliday = function(holidays, date) {
  const holiday = holidays.find(holiday => moment(holiday.date).isSame(date, 'day'));
  return holiday ? true : false;
}

module.exports = TimeUtils;