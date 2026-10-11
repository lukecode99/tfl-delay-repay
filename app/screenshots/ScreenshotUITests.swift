import XCTest

// Real iOS Simulator screenshots for TfL Delay Repay, driven as a genuine
// XCUITest. On a fresh install the app opens on the Welcome onboarding
// overlay; we capture that, dismiss it via "Get started", then walk the
// bottom tab bar by normalized coordinate (RN doesn't reliably expose tab
// labels to the a11y tree). Tabs (Rail flag off): Home | Journeys | Stats |
// Log | Alerts | About — six equal segments.
final class ScreenshotUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func tapTab(_ app: XCUIApplication, x: CGFloat) {
        // Bottom tab bar sits ~96.5% down the screen.
        let pt = app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.965))
        pt.tap()
        sleep(1)
    }

    @MainActor
    func testScreenshots() throws {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launch()
        sleep(4) // RN bundle render + initial live-ledger fetch

        // 1. First-launch onboarding — the value proposition.
        snapshot("01_Welcome")

        // Dismiss the welcome overlay. Prefer the real control; fall back to a
        // bottom-centre tap if the a11y label isn't exposed.
        let getStarted = app.buttons["Get started"]
        if getStarted.waitForExistence(timeout: 3) {
            getStarted.tap()
        } else if app.staticTexts["Get started"].exists {
            app.staticTexts["Get started"].tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)).tap()
        }
        sleep(2)

        // 2. Home dashboard.
        snapshot("02_Home")

        // 3. Alerts tab (5th of six segments).
        tapTab(app, x: 0.75)
        snapshot("03_Alerts")

        // 4. About tab (6th of six segments).
        tapTab(app, x: 0.917)
        snapshot("04_About")
    }
}
