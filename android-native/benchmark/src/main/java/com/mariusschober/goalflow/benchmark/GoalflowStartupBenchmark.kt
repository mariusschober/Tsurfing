package com.mariusschober.goalflow.benchmark

import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Startup performance guardrail for the product's first usable frame.
 * Run on a physical/emulated device with:
 * ./gradlew :benchmark:connectedCheck
 */
@RunWith(AndroidJUnit4::class)
class GoalflowStartupBenchmark {
    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    @Test
    fun cold_start_to_current() = benchmarkRule.measureRepeated(
        packageName = "com.mariusschober.tsurfing",
        metrics = listOf(StartupTimingMetric(), FrameTimingMetric()),
        iterations = 5,
        startupMode = StartupMode.COLD,
        setupBlock = {
            pressHome()
        }
    ) {
        startActivityAndWait()
    }
}
