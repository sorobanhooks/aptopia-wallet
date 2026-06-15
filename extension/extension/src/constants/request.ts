export enum RequestState {
  IDLE = "IDLE",
  LOADING = "LOADING",
  SUCCESS = "SUCCESS",
  ERROR = "ERROR",
}

export interface SuccessState<T> {
  state: RequestState.SUCCESS;
  data: T;
  error: null;
}

export interface ErrorState<T, K> {
  state: RequestState.ERROR;
  data: T | null;
  error: K;
}

export interface IdleState {
  state: RequestState.IDLE;
  data: null;
  error: null;
}

export interface LoadingState<T> {
  state: RequestState.LOADING;
  data: T | null;
  error: null;
}

export type State<T, K> =
  | IdleState
  | LoadingState<T>
  | SuccessState<T>
  | ErrorState<T, K>;

export type Action<T, K> =
  | { type: "FETCH_DATA_START" }
  | { type: "FETCH_DATA_SUCCESS"; payload: SuccessState<T>["data"] }
  | { type: "FETCH_DATA_ERROR"; payload: ErrorState<T, K>["error"] };
