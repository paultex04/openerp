/** A domain error the timesheet routes translate into an HTTP status + code. */
export class TimesheetError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TimesheetError';
  }
}
