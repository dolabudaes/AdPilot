import { SimulationClient } from "./simulationClient";

type SearchParams = {
  strategyId?: string;
};

export const dynamic = "force-dynamic";

export default function StrategySimulationPage({ searchParams }: { searchParams: SearchParams }) {
  return <SimulationClient strategyId={Number(searchParams.strategyId || 0)} />;
}
